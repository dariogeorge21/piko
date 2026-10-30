import { initialWorkflow, workflowReducer, type WorkflowAction } from './workflow.reducer'
import type { WorkflowToken, WorkflowDraft } from './workflow.types'
import type { ScanResult } from '../scanner/scanner.types'
import { inspectActivePage, stopScan } from '../scanner/scanner.service'
import { interpretAnswers } from '../interpretation/interpretation.service'
import { interpretationRequest, InterpretationError, isInterpretResponse } from '../interpretation/interpretation.validation'
import type { InterpretRequest, InterpretResponse } from '../interpretation/interpretation.generated'
import { cancelReview, requestFill } from '../filling/fill.service'
import type { FillInstruction, FillPanelRequest, FillResponse } from '../filling/fill.types'
import { makeId } from '../scanner/scanner.messages'
import { sessionAction, ensureSession } from './session-facts.service'
import type { SessionSnapshot, WorkflowContext } from './session-facts.types'
import { canApprove, liveContext, tokenMatches } from './workflow-guards'
import { eligibleFields, relevantFacts, selectedItems, validDraft } from './conversation-selectors'
import { nextQuestion } from './question-queue'
import { voiceSession } from '../voice-output/voice-session'

interface Dependencies {
  scan: () => Promise<ScanResult>; stopScan: (scan: ScanResult) => Promise<unknown>
  ensure: (scan: ScanResult) => Promise<SessionSnapshot | null>; status: () => Promise<SessionSnapshot | null>; clear: (sessionId: string | null) => Promise<unknown>
  interpret: (request: InterpretRequest, tabId: number, signal: AbortSignal, context: WorkflowContext & { requestId: string }) => Promise<InterpretResponse>
  fill: (request: FillPanelRequest, items: FillInstruction[]) => Promise<FillResponse>; cancelReview: (id: string) => Promise<void>
  speak: (text: string) => Promise<void>; stopSpeech: () => void; resetVoice: () => void; now: () => number
}
const defaults: Dependencies = { scan: inspectActivePage, stopScan, ensure: ensureSession, status: () => sessionAction({ type: 'PIKO_SESSION_STATUS' }), clear: sessionId => sessionAction({ type: 'PIKO_SESSION_CLEAR', sessionId }), interpret: interpretAnswers, fill: requestFill, cancelReview, speak: text => voiceSession.speak(text), stopSpeech: () => voiceSession.stopSpeech(), resetVoice: () => voiceSession.reset(), now: Date.now }

/** Typed service calls only. No raw DOM, HTTP, model commands or authorization construction. */
export class AssistantOrchestrator {
  private state = initialWorkflow()
  private listeners = new Set<() => void>()
  private operation: AbortController | null = null
  private epoch = 0
  private clearing: Promise<void> | null = null
  private reviewTimer: ReturnType<typeof setTimeout> | undefined
  private deps: Dependencies
  constructor(dependencies: Partial<Dependencies> = {}) { this.deps = { ...defaults, ...dependencies } }
  snapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private send(action: WorkflowAction) {
    const next = workflowReducer(this.state, action)
    if (next !== this.state) { this.state = next; for (const listener of this.listeners) listener() }
  }
  private token(): WorkflowToken { return { requestId: makeId('request'), sessionId: this.state.session!.sessionId, scanId: this.state.scan!.inventory.scanId, revision: this.state.revision } }
  private context(token: WorkflowToken): WorkflowContext & { requestId: string } { return { ...token, sessionVersion: this.state.session!.version } }
  private cancel() {
    this.epoch++; this.operation?.abort(); this.operation = null; clearTimeout(this.reviewTimer)
    if (this.state.review) void this.deps.cancelReview(this.state.review.reviewId)
    this.deps.stopSpeech()
  }
  async restore() {
    const epoch = this.epoch
    try { const session = await this.deps.status(); if (epoch === this.epoch && this.state.stage === 'idle') this.send({ type: 'SESSION', session }) }
    catch { if (epoch === this.epoch) this.send({ type: 'ERROR', error: 'session-storage-unavailable' }) }
  }
  async scan() {
    if (this.clearing) await this.clearing
    if (this.state.stage === 'filling' || this.state.stage === 'scanning') return
    this.cancel()
    const epoch = this.epoch, requestId = makeId('request')
    this.send({ type: 'SCAN_START', requestId })
    let result: ScanResult | null = null
    try {
      // Purge expired facts before creating the replacement document registry.
      await this.deps.status()
      if (epoch !== this.epoch || this.state.scanRequest !== requestId) return
      result = await this.deps.scan()
      if (epoch !== this.epoch || this.state.scanRequest !== requestId) { void this.deps.stopScan(result); return }
      const session = await this.deps.ensure(result)
      if (epoch !== this.epoch || this.state.scanRequest !== requestId) { void this.deps.stopScan(result); return }
      if (!session) throw Error()
      this.send({ type: 'SCAN_DONE', requestId, scan: result, session })
      this.askNext()
    } catch {
      if (result) void this.deps.stopScan(result)
      if (epoch === this.epoch) this.send({ type: 'ERROR', error: 'scan-failed' })
    }
  }
  private askNext() {
    const question = nextQuestion(this.state)
    this.speak(question?.spoken ?? (Object.keys(this.state.drafts).length ? 'Your answers are ready for review.' : 'No supported answers are available. You can finish manually.'))
  }
  private speak(text: string) { void this.deps.speak(text).catch(() => {}) }
  transcript(text: string) { if (this.state.stage === 'filling' || this.state.stage === 'stale') return; this.cancel(); this.send({ type: 'TRANSCRIPT', text }) }
  discard() { this.cancel(); this.send({ type: 'DISCARD' }) }
  revise(fieldId: string) { this.cancel(); this.send({ type: 'REVISE', fieldId }) }
  recordingStage(stage: string) { this.send({ type: 'TRANSCRIBING', busy: stage === 'processing' }) }
  edit(fieldId: string, change: Partial<Pick<WorkflowDraft, 'text' | 'selected' | 'overwrite'>>) {
    if (this.state.stage === 'filling') return
    this.cancel(); this.send({ type: 'EDIT', fieldId, change })
  }
  skip(fieldId: string) { this.cancel(); this.send({ type: 'SKIP', fieldId }); this.askNext() }
  async interpret(focusFieldId?: string) {
    if (!['collecting', 'review', 'error'].includes(this.state.stage) || !liveContext(this.state, this.deps.now()) || !this.state.transcript.trim()) return
    this.cancel()
    const token = this.token(), context = { ...this.context(token), ...(focusFieldId ? { focusFieldId } : {}) }, controller = new AbortController()
    this.operation = controller
    const request = interpretationRequest(this.state.scan!, this.state.transcript)
    if (focusFieldId) request.fields = request.fields.filter(field => field.fieldId === focusFieldId)
    request.knownFacts = relevantFacts(eligibleFields(this.state).filter(field => !focusFieldId || field.fieldId === focusFieldId), this.state.session)
    this.send({ type: 'INTERPRET_START', token })
    try {
      const stored = await this.deps.status()
      if (!tokenMatches(this.state, token) || controller.signal.aborted) return
      if (!stored || stored.sessionId !== context.sessionId || stored.version !== context.sessionVersion) throw new InterpretationError('session-expired')
      const result = await this.deps.interpret(request, this.state.scan!.tabId, controller.signal, context)
      if (!tokenMatches(this.state, token) || controller.signal.aborted) return
      if (!isInterpretResponse(result, request)) throw new InterpretationError('invalid-response')
      this.send({ type: 'INTERPRET_DONE', token, result }); this.askNext()
    } catch (cause) {
      if (tokenMatches(this.state, token) && !controller.signal.aborted) this.send({ type: 'ERROR', error: cause instanceof InterpretationError ? cause.code : 'service-unavailable' })
    } finally { if (this.operation === controller) this.operation = null }
  }
  cancelInterpretation() { this.cancel(); if (this.state.stage === 'interpreting') { this.send({ type: 'ERROR', error: 'request-cancelled' }) } }
  recover() { this.send({ type: 'RECOVER' }) }
  collect() { this.cancel(); this.send({ type: 'COLLECT' }); this.askNext() }
  async review() {
    if (!['collecting', 'review', 'results', 'error'].includes(this.state.stage) || !liveContext(this.state, this.deps.now())) return
    const items = selectedItems(this.state)
    if (!items.length || eligibleFields(this.state).some(field => this.state.drafts[field.fieldId]?.selected && !validDraft(field, this.state.drafts[field.fieldId]))) return
    this.cancel()
    const token = this.token(), workflow = this.context(token)
    this.send({ type: 'REVIEW_START', token })
    const response = await this.deps.fill({ type: 'PIKO_FILL_REVIEW', tabId: this.state.scan!.tabId, scanId: token.scanId, items, workflow: { sessionId: workflow.sessionId, sessionVersion: workflow.sessionVersion, revision: workflow.revision } }, items).catch((): FillResponse => ({ ok: false, error: 'unavailable' }))
    if (!tokenMatches(this.state, token)) { if (response.ok && 'reviewId' in response) void this.deps.cancelReview(response.reviewId); return }
    if (response.ok && 'reviewId' in response) {
      this.send({ type: 'REVIEW_READY', token, review: { reviewId: response.reviewId, expiresAt: response.expiresAt, items: structuredClone(items), revision: token.revision }, preflight: response.preflight })
      this.reviewTimer = setTimeout(() => this.expireReview(), Math.max(0, response.expiresAt - this.deps.now()))
    } else if (!response.ok) this.send({ type: 'ERROR', error: `fill-${response.error}`, outcome: response.preflight })
  }
  approveCheckbox(approved: boolean) { this.send({ type: 'APPROVAL', approved }) }
  rememberCheckbox(remember: boolean) { this.send({ type: 'REMEMBER', remember }) }
  expireReview() { if (this.state.review && this.state.stage !== 'filling') { this.cancel(); this.send({ type: 'ERROR', error: 'fill-expired' }) } }
  async fill() {
    if (!canApprove(this.state, this.deps.now())) return
    const review = this.state.review!, token = this.token(), context = this.context(token), rememberSelected = this.state.remember
    clearTimeout(this.reviewTimer); this.deps.stopSpeech()
    this.send({ type: 'FILL_START', token, now: this.deps.now() })
    const response = await this.deps.fill({ type: 'PIKO_FILL_APPROVE', reviewId: review.reviewId, workflow: { sessionId: context.sessionId, sessionVersion: context.sessionVersion, revision: context.revision }, rememberSelected }, review.items).catch((): FillResponse => ({ ok: false, error: 'unavailable' }))
    if (!tokenMatches(this.state, token)) return
    if (response.ok && 'result' in response) {
      this.send({ type: 'FILL_DONE', token, result: response.result, ...(response.memory?.session ? { session: response.memory.session } : {}) })
      this.speak('The approved batch has been checked. Review the field results. Submission is still manual.')
    } else if (!response.ok) this.send({ type: 'ERROR', error: `fill-${response.error}`, outcome: response.preflight })
  }
  stale(reason = 'page-changed') {
    if (this.state.stage === 'filling') { this.send({ type: 'STALE', reason }); this.deps.stopSpeech(); return }
    this.cancel(); this.send({ type: 'STALE', reason })
  }
  async refreshSession() {
    if (this.state.stage === 'filling' || this.state.stage === 'scanning') return
    const epoch = this.epoch
    try {
      const session = await this.deps.status()
      if (epoch !== this.epoch || ['filling', 'scanning'].includes(this.state.stage)) return
      if (session && this.state.session?.sessionId === session.sessionId && session.version < this.state.session.version) return
      if (session && this.state.session && (session.sessionId !== this.state.session.sessionId || session.version !== this.state.session.version)) this.stale('session-changed')
      if (!session) { this.cancel(); this.deps.resetVoice() }
      this.send({ type: 'SESSION', session })
    } catch { if (epoch === this.epoch) { this.cancel(); this.send({ type: 'ERROR', error: 'session-storage-unavailable' }) } }
  }
  clearScan() { if (this.state.stage === 'filling') return; this.cancel(); if (this.state.scan) void this.deps.stopScan(this.state.scan); const session = this.state.session; this.send({ type: 'CLEAR' }); if (session) this.send({ type: 'SESSION', session }) }
  async clearSession() {
    if (this.clearing) return this.clearing
    if (this.state.stage === 'filling') return
    const id = this.state.session?.sessionId ?? null
    this.cancel(); this.deps.resetVoice(); if (this.state.scan) void this.deps.stopScan(this.state.scan)
    this.send({ type: 'CLEAR' })
    const operation = this.deps.clear(id).then(() => {}, () => { this.send({ type: 'ERROR', error: 'session-storage-unavailable' }) })
    this.clearing = operation
    try { await operation } finally { if (this.clearing === operation) this.clearing = null }
  }
  dispose() { this.cancel(); this.deps.resetVoice(); if (this.state.scan) void this.deps.stopScan(this.state.scan) }
}

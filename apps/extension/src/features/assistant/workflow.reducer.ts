import type { ScanResult } from '../scanner/scanner.types'
import type { InterpretResponse } from '../interpretation/interpretation.generated'
import type { FillBatchResult, FillPreflight } from '../filling/fill.types'
import type { SessionSnapshot } from './session-facts.types'
import type { WorkflowDraft, WorkflowReview, WorkflowState, WorkflowToken } from './workflow.types'
import { eligibleFields, emptyDraft, reusableDrafts } from './conversation-selectors'
import { nextQuestion } from './question-queue'
import { canApprove, canTransition, liveContext, tokenMatches } from './workflow-guards'

export function initialWorkflow(): WorkflowState {
  return { stage: 'idle', revision: 0, mediaRevision: 0, scan: null, session: null, scanRequest: null, pending: null, transcript: '', drafts: {}, evidence: {}, clarifications: [], skipped: [], verified: [], messages: [], review: null, approved: false, remember: false, outcome: null, error: null, staleReason: null }
}
export type WorkflowAction =
  | { type: 'SCAN_START'; requestId: string }
  | { type: 'SCAN_DONE'; requestId: string; scan: ScanResult; session: SessionSnapshot }
  | { type: 'SESSION'; session: SessionSnapshot | null }
  | { type: 'TRANSCRIPT'; text: string }
  | { type: 'DISCARD' }
  | { type: 'REVISE'; fieldId: string }
  | { type: 'TRANSCRIBING'; busy: boolean }
  | { type: 'INTERPRET_START'; token: WorkflowToken }
  | { type: 'INTERPRET_DONE'; token: WorkflowToken; result: InterpretResponse }
  | { type: 'EDIT'; fieldId: string; change: Partial<Pick<WorkflowDraft, 'text' | 'selected' | 'overwrite'>> }
  | { type: 'SKIP'; fieldId: string }
  | { type: 'REVIEW_START'; token: WorkflowToken }
  | { type: 'REVIEW_READY'; token: WorkflowToken; review: WorkflowReview; preflight: FillPreflight }
  | { type: 'APPROVAL'; approved: boolean }
  | { type: 'REMEMBER'; remember: boolean }
  | { type: 'FILL_START'; token: WorkflowToken; now: number }
  | { type: 'FILL_DONE'; token: WorkflowToken; result: FillBatchResult; session?: SessionSnapshot | null }
  | { type: 'STALE'; reason: string }
  | { type: 'ERROR'; error: string; outcome?: FillPreflight }
  | { type: 'RECOVER' }
  | { type: 'COLLECT' }
  | { type: 'CLEAR' }

const editable = ['collecting', 'interpreting', 'review', 'approving', 'results', 'error']
function revoke(state: WorkflowState) { return { ...state, revision: state.revision + 1, pending: null, review: null, approved: false, remember: false, error: null } }
function history(messages: WorkflowState['messages']): WorkflowState['messages'] {
  const next = messages.slice(-20)
  while (next.reduce((total, item) => total + item.text.length, 0) > 32768) next.shift()
  return next
}
export function workflowReducer(state: WorkflowState, action: WorkflowAction): WorkflowState {
  switch (action.type) {
    case 'CLEAR': return state.stage === 'filling' ? state : { ...initialWorkflow(), revision: state.revision + 1, mediaRevision: state.mediaRevision + 1 }
    case 'SESSION':
      if (!action.session) return { ...initialWorkflow(), revision: state.revision + 1, mediaRevision: state.mediaRevision + 1, error: state.session ? 'session-expired' : null }
      if (state.session && state.session.sessionId !== action.session.sessionId && state.stage !== 'idle') return { ...revoke(state), session: action.session, stage: 'stale', staleReason: 'session-changed' }
      return { ...state, session: action.session }
    case 'SCAN_START':
      if (!canTransition(state.stage, 'scanning')) return state
      return { ...initialWorkflow(), session: state.session, revision: state.revision + 1, mediaRevision: state.mediaRevision + 1, stage: 'scanning', scanRequest: action.requestId }
    case 'SCAN_DONE': {
      if (state.stage !== 'scanning' || state.scanRequest !== action.requestId || action.session.origin !== action.scan.inventory.origin || action.session.expiresAt <= Date.now()) return state
      const fields = action.scan.inventory.forms.flatMap(form => form.fields)
      return { ...state, stage: 'collecting', scanRequest: null, scan: action.scan, session: action.session, drafts: reusableDrafts(fields, action.session) }
    }
    case 'TRANSCRIPT':
      if (!editable.includes(state.stage) && state.stage !== 'transcribing' || !liveContext(state) || action.text.length > 4096) return state
      return { ...revoke(state), transcript: action.text, mediaRevision: state.mediaRevision + 1, stage: 'collecting' }
    case 'DISCARD':
      if (!editable.includes(state.stage) || !liveContext(state)) return state
      return { ...revoke(state), stage: 'collecting', transcript: '', messages: [], clarifications: [], evidence: {}, drafts: Object.fromEntries(Object.entries(state.drafts).filter(([, draft]) => draft.source !== 'model' || draft.protected)), mediaRevision: state.mediaRevision + 1 }
    case 'REVISE': {
      if (!editable.includes(state.stage) || !liveContext(state) || !eligibleFields(state).some(field => field.fieldId === action.fieldId)) return state
      const drafts = { ...state.drafts }, evidence = { ...state.evidence }
      delete drafts[action.fieldId]; delete evidence[action.fieldId]
      return { ...revoke(state), stage: 'collecting', drafts, evidence, transcript: '', mediaRevision: state.mediaRevision + 1, clarifications: state.clarifications.filter(item => !item.targetFieldIds.includes(action.fieldId)) }
    }
    case 'TRANSCRIBING':
      if (action.busy && (state.stage === 'collecting' || state.stage === 'review')) return { ...revoke(state), stage: 'transcribing' }
      if (!action.busy && state.stage === 'transcribing') return { ...state, stage: 'collecting' }
      return state
    case 'INTERPRET_START':
      if (!['collecting', 'review', 'error'].includes(state.stage) || !liveContext(state) || !state.transcript.trim() || action.token.revision !== state.revision) return state
      return { ...state, stage: 'interpreting', pending: action.token, review: null, approved: false, remember: false, error: null }
    case 'INTERPRET_DONE': {
      if (state.stage !== 'interpreting' || !tokenMatches(state, action.token) || !liveContext(state) || action.result.scanId !== action.token.scanId) return state
      const drafts = { ...state.drafts }, evidence = { ...state.evidence }, fields = eligibleFields(state)
      for (const update of action.result.updates) {
        if (!fields.some(field => field.fieldId === update.fieldId && field.fieldType === update.target.kind) || drafts[update.fieldId]?.protected) continue
        evidence[update.fieldId] = update.evidence
        drafts[update.fieldId] = { text: 'value' in update.target ? update.target.value : 'optionId' in update.target ? update.target.optionId : String(update.target.checked), source: 'model', protected: false, selected: false, overwrite: false }
      }
      const merged: WorkflowState = { ...state, drafts, evidence, pending: null, clarifications: action.result.clarifications.filter(item => item.targetFieldIds.every(id => fields.some(field => field.fieldId === id)) && !item.targetFieldIds.some(id => drafts[id]?.protected)), messages: history([...state.messages, { role: 'user', text: state.transcript }, { role: 'assistant', text: 'Validated proposals are ready to review. Missing answers remain unresolved.' }]) }
      return { ...merged, stage: nextQuestion(merged) ? 'collecting' : 'review' }
    }
    case 'EDIT': {
      if (!editable.includes(state.stage) || !liveContext(state) || action.change.text !== undefined && action.change.text.length > 1024 || !eligibleFields(state).some(field => field.fieldId === action.fieldId)) return state
      const current = state.drafts[action.fieldId] ?? emptyDraft()
      return { ...revoke(state), outcome: null, mediaRevision: state.mediaRevision + 1, stage: state.stage === 'review' ? 'review' : 'collecting', drafts: { ...state.drafts, [action.fieldId]: { ...current, ...action.change, source: 'manual', protected: true } }, clarifications: state.clarifications.filter(item => !item.targetFieldIds.includes(action.fieldId)) }
    }
    case 'SKIP':
      if (!['collecting', 'review'].includes(state.stage) || !liveContext(state) || !eligibleFields(state).some(field => field.fieldId === action.fieldId)) return state
      return { ...revoke(state), skipped: [...new Set([...state.skipped, action.fieldId])] }
    case 'REVIEW_START':
      if (!['collecting', 'review', 'results', 'error'].includes(state.stage) || !liveContext(state)) return state
      return { ...state, stage: 'approving', pending: action.token, review: null, approved: false, remember: false, error: null, outcome: null }
    case 'REVIEW_READY':
      if (state.stage !== 'approving' || !tokenMatches(state, action.token) || !liveContext(state)) return state
      return { ...state, stage: 'review', pending: null, review: action.review, outcome: action.preflight }
    case 'APPROVAL': return state.stage === 'review' && state.review && liveContext(state) ? { ...state, approved: action.approved } : state
    case 'REMEMBER': return state.stage === 'review' && state.review && liveContext(state) ? { ...state, remember: action.remember } : state
    case 'FILL_START': return canApprove(state, action.now) ? { ...state, stage: 'filling', pending: action.token, approved: false } : state
    case 'FILL_DONE': {
      if (state.stage !== 'filling' || !tokenMatches(state, action.token)) return state
      const verified = [...new Set([...state.verified, ...action.result.results.filter(item => ['filled', 'already-matched'].includes(item.status)).map(item => item.fieldId)])]
      return { ...state, stage: 'results', pending: null, review: null, approved: false, remember: false, session: action.session === undefined ? state.session : action.session, verified, outcome: action.result, drafts: Object.fromEntries(Object.entries(state.drafts).map(([id, draft]) => [id, { ...draft, selected: false, overwrite: false }])) }
    }
    case 'STALE':
      if (state.stage === 'idle') return state
      if (state.stage === 'filling') return { ...state, staleReason: action.reason, review: null, approved: false }
      return { ...revoke(state), scanRequest: null, mediaRevision: state.mediaRevision + 1, stage: 'stale', staleReason: action.reason }
    case 'ERROR': return { ...state, stage: 'error', pending: null, review: null, approved: false, remember: false, error: action.error, outcome: action.outcome ?? state.outcome }
    case 'RECOVER': return state.stage === 'error' && liveContext(state) ? { ...state, stage: 'collecting', error: null } : state
    case 'COLLECT': return ['review', 'results', 'error'].includes(state.stage) && liveContext(state) ? { ...revoke(state), stage: 'collecting' } : state
  }
}

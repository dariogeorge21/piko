import type { WorkflowContext } from '../assistant/session-facts.types'
import { hasKeys, isRecord, makeId } from '../scanner/scanner.messages'
import { InterpretationError, interpretationErrors, isInterpretResponse, type InterpretMessage } from './interpretation.validation'
import type { InterpretRequest, InterpretResponse } from './interpretation.generated'

export async function interpretAnswers(payload: InterpretRequest, tabId: number, signal: AbortSignal, context?: WorkflowContext & { requestId: string; focusFieldId?: string }): Promise<InterpretResponse> {
  const request: InterpretMessage = { type: 'PIKO_INTERPRET', requestId: context?.requestId ?? makeId('request'), tabId, payload, ...(context?.focusFieldId ? { focusFieldId: context.focusFieldId } : {}), ...(context ? { workflow: { sessionId: context.sessionId, sessionVersion: context.sessionVersion, revision: context.revision } } : {}) }
  const cancel = () => { void chrome.runtime.sendMessage({ type: 'PIKO_INTERPRET_CANCEL', requestId: request.requestId }).catch(() => {}) }
  if (signal.aborted) throw new InterpretationError('request-cancelled')
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const reply: unknown = await chrome.runtime.sendMessage(request)
    if (signal.aborted) throw new InterpretationError('request-cancelled')
    if (!isRecord(reply) || reply.requestId !== request.requestId) throw new InterpretationError('invalid-response')
    if (reply.ok === false && hasKeys(reply, ['ok', 'requestId', 'error']) && (interpretationErrors as readonly unknown[]).includes(reply.error)) throw new InterpretationError(reply.error as InterpretationError['code'])
    if (reply.ok !== true || !hasKeys(reply, ['ok', 'requestId', 'result']) || !isInterpretResponse(reply.result, payload)) throw new InterpretationError('invalid-response')
    return reply.result
  } catch (error) {
    if (error instanceof InterpretationError) throw error
    throw new InterpretationError('service-unavailable')
  } finally { signal.removeEventListener('abort', cancel) }
}

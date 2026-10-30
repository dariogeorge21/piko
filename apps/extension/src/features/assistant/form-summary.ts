import type { InterpretRequest } from '../interpretation/interpretation.generated'
import { interpretationRequest, isInterpretMessage, InterpretationError } from '../interpretation/interpretation.validation'
import { hasKeys, isRecord, makeId } from '../scanner/scanner.messages'
import { isSpeechText } from '../voice-output/speech.validation'
import type { ScanResult } from '../scanner/scanner.types'

export type SummaryRequest = Pick<InterpretRequest, 'scanId' | 'fields'>
export interface FormSummary { scanId: string; summary: string }
export interface SummaryMessage { type: 'PIKO_SUMMARIZE'; requestId: string; tabId: number; payload: SummaryRequest }
export function isSummaryMessage(value: unknown): value is SummaryMessage {
  if (!isRecord(value) || value.type !== 'PIKO_SUMMARIZE' || !hasKeys(value, ['type', 'requestId', 'tabId', 'payload']) || !isRecord(value.payload) || !hasKeys(value.payload, ['scanId', 'fields'])) return false
  return isInterpretMessage({ ...value, type: 'PIKO_INTERPRET', payload: { ...value.payload, transcript: 'Form summary', knownFacts: [] } })
}
export function isFormSummary(value: unknown, scanId: string): value is FormSummary {
  return isRecord(value) && hasKeys(value, ['scanId', 'summary']) && value.scanId === scanId && typeof value.summary === 'string' && value.summary.length <= 500 && isSpeechText(value.summary)
}
export async function summarizeForm(scan: ScanResult, signal: AbortSignal): Promise<FormSummary> {
  const { scanId, fields } = interpretationRequest(scan, 'Form summary')
  const request: SummaryMessage = { type: 'PIKO_SUMMARIZE', requestId: makeId('request'), tabId: scan.tabId, payload: { scanId, fields } }
  const cancel = () => { void chrome.runtime.sendMessage({ type: 'PIKO_INTERPRET_CANCEL', requestId: request.requestId }).catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    if (signal.aborted) throw new InterpretationError('request-cancelled')
    const reply: unknown = await chrome.runtime.sendMessage(request)
    if (signal.aborted) throw new InterpretationError('request-cancelled')
    if (!isRecord(reply) || reply.requestId !== request.requestId || reply.ok !== true || !isFormSummary(reply.result, scanId)) throw new InterpretationError('service-unavailable')
    return reply.result
  } finally { signal.removeEventListener('abort', cancel) }
}

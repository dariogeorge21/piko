import { isWorkflowContext } from '../assistant/session-facts.validation'
import { supportedText } from './spoken-evidence'
import { invalidNameValue, isNameField, requestedNameValue } from './name-intent'
import type { WorkflowContext } from '../assistant/session-facts.types'
import validateRequest from './request-schema.generated.js'
import validateResponse from './response-schema.generated.js'
import { hasKeys, isOpaqueId, isRecord } from '../scanner/scanner.messages'
import type { ScanField, ScanResult } from '../scanner/scanner.types'
import type { InterpretRequest, InterpretResponse } from './interpretation.generated'

export const interpretationErrors = ['model-unavailable', 'interpretation-timeout', 'invalid-model-output', 'unknown-field-id', 'invalid-option-id', 'target-type-mismatch', 'duplicate-field-update', 'unsupported-evidence', 'proposal-validation-failed', 'invalid_request', 'body_too_large', 'interpretation-busy', 'request-cancelled', 'session-expired', 'service-unavailable', 'stale-scan', 'invalid-response'] as const
export type InterpretationErrorCode = typeof interpretationErrors[number]
export class InterpretationError extends Error { constructor(readonly code: InterpretationErrorCode) { super(code) } }
export interface InterpretMessage { type: 'PIKO_INTERPRET'; requestId: string; tabId: number; payload: InterpretRequest; workflow?: WorkflowContext; focusFieldId?: string }
export type InterpretReply = { ok: true; requestId: string; result: InterpretResponse } | { ok: false; requestId: string; error: InterpretationErrorCode }
export function isInterpretMessage(value: unknown): value is InterpretMessage {
  if (!isRecord(value)) return false
  const keys = ['type', 'requestId', 'tabId', 'payload', ...(value.workflow === undefined ? [] : ['workflow']), ...(value.focusFieldId === undefined ? [] : ['focusFieldId'])]
  return hasKeys(value, keys) && (value.workflow === undefined || isWorkflowContext(value.workflow)) && (value.focusFieldId === undefined || isOpaqueId(value.focusFieldId)) && value.type === 'PIKO_INTERPRET' && isOpaqueId(value.requestId) && Number.isSafeInteger(value.tabId) && Number(value.tabId) >= 0 && validateRequest(value.payload) && new Set(value.payload.fields.map(field => field.fieldId)).size === value.payload.fields.length
}
export function eligibleMetadata(fields: ScanField[]): InterpretRequest['fields'] {
  return fields.filter(field => field.eligible).map(field => ({ fieldId: field.fieldId, label: field.label, type: field.fieldType, required: field.required, options: field.options.filter(option => !option.disabled).map(({ optionId, label }) => ({ optionId, label })), constraints: { ...field.constraints } }))
}
export function interpretationRequest(scan: ScanResult, transcript: string): InterpretRequest {
  return { scanId: scan.inventory.scanId, transcript, knownFacts: [], fields: eligibleMetadata(scan.inventory.forms.flatMap(form => form.fields)) }
}
export function isInterpretResponse(value: unknown, request: InterpretRequest): value is InterpretResponse {
  if (!validateResponse(value) || value.scanId !== request.scanId) return false
  const fields = new Map(request.fields.map(field => [field.fieldId, field]))
  const updates = new Set<string>()
  for (const update of value.updates) {
    const field = fields.get(update.fieldId)
    if (!field || updates.has(update.fieldId) || update.target.kind !== field.type) return false
    updates.add(update.fieldId)
    if ('optionId' in update.target && !field.options.some(option => option.optionId === ('optionId' in update.target ? update.target.optionId : ''))) return false
    const evidence = update.evidence
    const source = evidence.source === 'transcript' && evidence.factId === null ? request.transcript : evidence.source === 'fact' ? request.knownFacts.find(fact => fact.factId === evidence.factId)?.text : undefined
    if (!source || !evidence.quote.trim() || !source.includes(evidence.quote)) return false
    if ('value' in update.target) {
      if (isNameField(field.label) && invalidNameValue(update.target.value)) return false
      if (!update.target.value.trim() || !supportedText(update.target.kind, update.target.value, evidence.quote, field.label) && !(update.target.kind === 'text' && request.fields.length === 1 && requestedNameValue(field.label, update.target.value, request.transcript, evidence.quote))) return false
    }
  }
  const clarificationIds = new Set<string>()
  for (const clarification of value.clarifications) {
    for (const id of clarification.targetFieldIds) {
      if (!fields.has(id) || updates.has(id) || clarificationIds.has(id)) return false
      clarificationIds.add(id)
    }
  }
  const expectedMissing = request.fields.filter(field => field.required && !updates.has(field.fieldId)).map(field => field.fieldId)
  return value.missingFields.length === expectedMissing.length && new Set(value.missingFields.map(field => field.fieldId)).size === value.missingFields.length && value.missingFields.every(field => expectedMissing.includes(field.fieldId))
}

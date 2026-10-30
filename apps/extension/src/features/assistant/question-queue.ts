import { eligibleFields, validDraft } from './conversation-selectors'
import type { QuestionItem, WorkflowState } from './workflow.types'
import { cleanLabel } from '../interpretation/name-intent'

const spoken: Record<string, string> = { 'full name': 'What is your full name?', name: 'What is your full name?', email: 'What is your email address?', 'email address': 'What is your email address?', department: 'Which department should I use?', 'phone number': 'What is your phone number?' }
export function questionQueue(state: WorkflowState): QuestionItem[] {
  if (!state.scan || state.staleReason) return []
  return eligibleFields(state).flatMap(field => {
    if (state.verified.includes(field.fieldId)) return []
    const clarification = state.clarifications.find(item => item.targetFieldIds.includes(field.fieldId))
    if (!clarification && (!field.required || validDraft(field, state.drafts[field.fieldId]))) return []
    const cleaned = cleanLabel(field.label)
    const question = clarification?.question ?? `What should I enter for ${cleaned || field.label}?`
    return [{ fieldId: field.fieldId, scanId: state.scan!.inventory.scanId, question, spoken: spoken[cleaned.toLowerCase()] ?? 'Please provide an answer for this field.', ambiguous: Boolean(clarification), skipped: state.skipped.includes(field.fieldId) }]
  })
}
export function nextQuestion(state: WorkflowState) { return questionQueue(state).find(item => !item.skipped) ?? null }

import type { FillInstruction, FillValue } from '../filling/fill.types'
import type { ScanField } from '../scanner/scanner.types'
import type { ApprovedFact } from '../interpretation/interpretation.generated'
import type { SessionSnapshot } from './session-facts.types'
import { factKey } from './session-facts.validation'
import type { WorkflowDraft, WorkflowState } from './workflow.types'

export function eligibleFields(state: WorkflowState) { return state.scan?.inventory.forms.flatMap(form => form.fields).filter(field => field.eligible) ?? [] }
export function emptyDraft(): WorkflowDraft { return { text: '', selected: false, overwrite: false, source: 'manual', protected: false } }
export function targetFor(field: ScanField, text: string): FillValue {
  return field.fieldType === 'checkbox' ? { kind: 'checkbox', checked: text === 'true' } : field.fieldType === 'select' || field.fieldType === 'radio' ? { kind: field.fieldType, optionId: text } : { kind: field.fieldType, value: text }
}
const numeric = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i
function validNumber(text: string) { return numeric.test(text) && Number.isFinite(Number(text)) }
function validDate(text: string) {
  const timestamp = Date.parse(text)
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !text.startsWith('0000') && Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === text
}
export function validDraft(field: ScanField, draft?: WorkflowDraft): boolean {
  if (!draft || !draft.text.trim()) return false
  if (field.fieldType === 'checkbox') return ['true', 'false'].includes(draft.text) && (!field.required || draft.text === 'true')
  if (['select', 'radio'].includes(field.fieldType)) return field.options.some(option => option.optionId === draft.text && !option.disabled)
  if (['text', 'textarea'].includes(field.fieldType)) return true
  if (field.fieldType === 'email' && !/^[^\s@]+@[^\s@]+$/.test(draft.text)) return false
  if (field.fieldType === 'number') {
    if (!validNumber(draft.text)) return false
    const { min, max } = field.constraints, value = Number(draft.text)
    if (min !== undefined && validNumber(min) && value < Number(min) || max !== undefined && validNumber(max) && value > Number(max)) return false
  }
  if (field.fieldType === 'date') {
    if (!validDate(draft.text)) return false
    const { min, max } = field.constraints
    if (min !== undefined && validDate(min) && draft.text < min || max !== undefined && validDate(max) && draft.text > max) return false
  }
  return true // Exact native constraints remain enforced by Step 6 preflight.
}
export function selectedItems(state: WorkflowState): FillInstruction[] {
  return eligibleFields(state).filter(field => state.drafts[field.fieldId]?.selected).map(field => ({ fieldId: field.fieldId, target: targetFor(field, state.drafts[field.fieldId].text), overwriteExisting: state.drafts[field.fieldId].overwrite }))
}
export function reusableDrafts(fields: ScanField[], session: SessionSnapshot): Record<string, WorkflowDraft> {
  const drafts: Record<string, WorkflowDraft> = {}
  if (session.expiresAt <= Date.now()) return drafts
  for (const field of fields) {
    const key = factKey(field), fact = session.facts.find(fact => fact.key === key)
    if (!fact) continue
    let text = fact.value
    if (['select', 'radio'].includes(field.fieldType)) {
      const options = field.options.filter(option => !option.disabled && option.label.toLowerCase() === text.toLowerCase())
      if (options.length !== 1) continue
      text = options[0].optionId
    }
    const draft: WorkflowDraft = { text, source: 'session', protected: false, selected: false, overwrite: false }
    if (validDraft(field, draft)) drafts[field.fieldId] = draft
  }
  return drafts
}
export function relevantFacts(fields: ScanField[], session: SessionSnapshot | null): ApprovedFact[] {
  if (!session || session.expiresAt <= Date.now()) return []
  const keys = new Set(fields.map(factKey).filter(Boolean))
  return session.facts.filter(fact => keys.has(fact.key)).map(fact => ({ factId: fact.factId, text: `${fact.key.replace(/_/g, ' ')}: ${fact.value}` }))
}

export function unverifiedRequired(state: WorkflowState) { return eligibleFields(state).filter(field => field.required && !state.verified.includes(field.fieldId)) }

import { FieldRegistry, identity, type RegisteredField } from './field-registry'
import { fieldType, sensitive } from './scan-document'
import { extractLabel, type Control } from './label-extractor'
import { isEnabled, isVisible } from './visibility'
import type { BoundInstruction, FillAuthorization, FillBatchResult, FillContext, FillItemResult, FillPreflight } from '../features/filling/fill.types'
import { contextOf, isAuthorization } from '../features/filling/fill.validation'

function control(element: Element): element is Control {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
}
function nativeSet(element: Control, property: 'value' | 'checked' | 'selectedIndex', value: string | boolean | number) {
  const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, property)?.set
  if (!setter) throw new Error('Unsupported setter')
  setter.call(element, value)
}
function optionFor(entry: RegisteredField, item: BoundInstruction): Element | undefined {
  return 'optionId' in item.target ? entry.options.get(item.target.optionId)?.element : undefined
}
function matches(entry: RegisteredField, item: BoundInstruction): boolean {
  const element = entry.elements[0] as Control
  if ('value' in item.target) return element.value === item.target.value
  if ('checked' in item.target) return (element as HTMLInputElement).checked === item.target.checked
  const option = optionFor(entry, item)
  return element instanceof HTMLSelectElement ? element.selectedOptions.length === 1 && element.selectedOptions[0] === option : entry.elements.every((node) => (node as HTMLInputElement).checked === (node === option))
}
function conflicts(entry: RegisteredField): boolean {
  const element = entry.elements[0] as Control
  if (element instanceof HTMLSelectElement) return [...element.selectedOptions].some((option) => option.value !== '' && !option.disabled)
  if (element instanceof HTMLInputElement && ['radio', 'checkbox'].includes(element.type)) return entry.elements.some((node) => (node as HTMLInputElement).checked)
  return element.value !== ''
}
function validValue(entry: RegisteredField, item: BoundInstruction): boolean {
  const element = entry.elements[0] as Control
  if (element.validity.customError) return false
  // Detached native controls validate proposals without touching live state or
  // firing page events. Native minlength/maxlength need explicit checks because
  // browsers apply them only to user edits, not programmatic assignments.
  const clone = element.cloneNode(true) as Control
  if ('value' in item.target) {
    const text = item.target.value
    if (item.target.kind === 'number' && text !== '' && (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) || !Number.isFinite(Number(text)))) return false
    if (item.target.kind === 'date' && text !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
    nativeSet(clone, 'value', text)
    if (clone.value !== text) return false
  } else if ('checked' in item.target) nativeSet(clone, 'checked', item.target.checked)
  else if (clone instanceof HTMLSelectElement) nativeSet(clone, 'selectedIndex', [...(element as HTMLSelectElement).options].indexOf(optionFor(entry, item) as HTMLOptionElement))
  else { nativeSet(clone, 'checked', true) }
  if (entry.metadata.required && ('value' in item.target ? item.target.value === '' : 'checked' in item.target ? !item.target.checked : false)) return false
  if (entry.metadata.required && clone instanceof HTMLSelectElement && clone.value === '') return false
  if (item.target.kind === 'text' || item.target.kind === 'textarea') return true
  return clone.validity.valid
}

export class FillEngine {
  private consumed = new Set<string>()
  private busy = false
  constructor(private readonly registry: FieldRegistry, private readonly currentContext: () => FillContext | null, private readonly current: () => boolean, private readonly now = Date.now, private readonly settle = () => new Promise<void>((resolve) => setTimeout(resolve, 100))) {}

  private contextMatches(context: FillContext): boolean {
    const actual = this.currentContext()
    return Boolean(actual && actual.tabId === context.tabId && actual.scanId === context.scanId && actual.documentId === context.documentId && actual.origin === context.origin && location.origin === context.origin && this.registry.documentId === context.documentId && this.current())
  }
  private check(context: FillContext, item: BoundInstruction): FillItemResult {
    const fail = (status: FillItemResult['status'], reason: FillItemResult['reason']): FillItemResult => ({ fieldId: item.fieldId, status, reason })
    if (!this.contextMatches(context)) return fail('stale', 'context')
    const entry = this.registry.entry(item.fieldId, context.scanId)
    if (!entry || entry.formId !== item.formId) return fail('stale', 'unknown-field')
    if (!entry.metadata.eligible) return fail('blocked', 'ineligible')
    if (item.target.kind === 'radio') {
      const first = entry.elements[0] as HTMLInputElement
      const members = first.name ? [...document.getElementsByName(first.name)].filter((node) => node instanceof HTMLInputElement && node.type === 'radio' && node.form === first.form) : [first]
      if (members.length !== entry.elements.length || members.some((node) => !entry.elements.includes(node))) return fail('stale', 'page-changed')
    }
    for (const [index, node] of entry.elements.entries()) {
      if (!control(node) || identity(node) !== entry.signatures[index] || (node.form ?? document) !== entry.owner) return fail('stale', 'page-changed')
      if (fieldType(node) !== item.target.kind) return fail('invalid', 'type')
      if (sensitive(node, extractLabel(node).label) || node.hasAttribute('readonly') || node.getAttribute('aria-readonly') === 'true') return fail('blocked', 'ineligible')
      if (item.target.kind !== 'radio' && (!isVisible(node) || !isEnabled(node))) return fail('blocked', 'ineligible')
    }
    if ('optionId' in item.target) {
      const registered = entry.options.get(item.target.optionId)
      if (!registered) return fail('invalid', 'option')
      const option = registered.element
      if (!option.isConnected || identity(option) !== registered.signature) return fail('stale', 'page-changed')
      if (option instanceof HTMLOptionElement ? option.closest('select') !== entry.elements[0] || option.disabled || option.closest('optgroup')?.disabled : !entry.elements.includes(option) || !isEnabled(option) || !isVisible(option)) return fail('blocked', 'option')
    }
    if (!validValue(entry, item)) return fail('invalid', 'constraint')
    if (matches(entry, item)) return { fieldId: item.fieldId, status: 'already-matched' }
    if (!item.overwriteExisting && conflicts(entry)) return fail('blocked', 'existing-value')
    return { fieldId: item.fieldId, status: 'not-verified' }
  }
  preflight(context: FillContext, items: BoundInstruction[]): FillPreflight {
    const results = items.map((item) => { try { return this.check(context, item) } catch { return { fieldId: item.fieldId, status: 'rejected' as const, reason: 'unverified' as const } } })
    return { ok: results.every((result) => result.status === 'already-matched' || result.status === 'not-verified' && !result.reason), results }
  }
  async commit(authorization: FillAuthorization): Promise<FillBatchResult> {
    const reject = (reason: FillItemResult['reason']): FillBatchResult => ({ batchId: authorization.batchId, status: 'rejected', results: authorization.items.map(({ fieldId }) => ({ fieldId, status: 'rejected', reason })) })
    if (!isAuthorization(authorization)) return reject('context')
    if (this.consumed.has(authorization.batchId)) return reject('replayed')
    // Consume before any validation or await, including failed attempts. Bound
    // memory without evicting replay protection: request a fresh scan at limit.
    if (this.consumed.size >= 1000) return reject('context')
    this.consumed.add(authorization.batchId)
    if (this.now() < authorization.issuedAt || this.now() >= authorization.expiresAt) return reject('expired')
    if (this.busy) return reject('context')
    const context = contextOf(authorization)
    const preflight = this.preflight(context, authorization.items)
    if (!preflight.ok) return { batchId: authorization.batchId, status: 'rejected', results: preflight.results.map((result) => result.status === 'already-matched' || !result.reason ? { fieldId: result.fieldId, status: 'rejected', reason: 'batch-invalid' } : result) }
    this.busy = true
    let wrote = false
    const results: FillItemResult[] = []
    const changed = new Set<string>()
    try {
      for (const item of authorization.items) {
        const check = this.check(context, item)
        if (check.reason || check.status === 'already-matched') { results.push(check); continue }
        if (this.now() >= authorization.expiresAt) { results.push({ fieldId: item.fieldId, status: 'rejected', reason: 'expired' }); continue }
        const entry = this.registry.entry(item.fieldId, context.scanId)!
        try {
          const element = entry.elements[0] as Control
          let eventTarget = element
          wrote = true; changed.add(item.fieldId)
          if ('value' in item.target) nativeSet(element, 'value', item.target.value)
          else if ('checked' in item.target) nativeSet(element, 'checked', item.target.checked)
          else if (element instanceof HTMLSelectElement) nativeSet(element, 'selectedIndex', [...element.options].indexOf(optionFor(entry, item) as HTMLOptionElement))
          else { eventTarget = optionFor(entry, item) as HTMLInputElement; nativeSet(eventTarget, 'checked', true) }
          eventTarget.dispatchEvent(new Event('input', { bubbles: true }))
          eventTarget.dispatchEvent(new Event('change', { bubbles: true }))
          results.push(this.verify(context, item, entry))
        } catch { results.push({ fieldId: item.fieldId, status: 'not-verified', reason: 'unverified' }) }
      }
      await this.settle()
      // Verify the entire batch again: later handlers may alter earlier fields.
      for (const [index, item] of authorization.items.entries()) {
        if (!['filled', 'already-matched'].includes(results[index].status)) continue
        const entry = this.registry.entry(item.fieldId, context.scanId)
        results[index] = entry ? this.verify(context, item, entry, changed.has(item.fieldId)) : { fieldId: item.fieldId, status: 'not-verified', reason: 'page-changed' }
      }
      return { batchId: authorization.batchId, status: results.every((result) => ['filled', 'already-matched'].includes(result.status)) ? 'completed' : wrote ? 'partial' : 'rejected', results }
    } finally { this.busy = false }
  }
  private verify(context: FillContext, item: BoundInstruction, entry: RegisteredField, changed = true): FillItemResult {
    if (!this.contextMatches(context) || !this.registry.entry(item.fieldId, context.scanId)) return { fieldId: item.fieldId, status: 'not-verified', reason: 'page-changed' }
    if (!matches(entry, item)) return { fieldId: item.fieldId, status: 'rejected', reason: 'page-reverted' }
    if (!validValue(entry, item)) return { fieldId: item.fieldId, status: 'rejected', reason: 'constraint' }
    return { fieldId: item.fieldId, status: changed ? 'filled' : 'already-matched' }
  }
}

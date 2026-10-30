const formControlSelector = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]),textarea,select,option,fieldset,[role="radiogroup"]'
const watchedAttributes = ['id', 'name', 'type', 'form', 'for', 'aria-labelledby', 'aria-label', 'aria-hidden', 'hidden', 'disabled', 'aria-disabled', 'readonly', 'aria-readonly', 'required', 'aria-required', 'inert', 'min', 'max', 'minlength', 'maxlength', 'pattern', 'step', 'placeholder', 'multiple', 'autocomplete', 'role', 'label', 'value']

function isIgnoredInput(element: Element): boolean {
  return element instanceof HTMLInputElement && ['hidden', 'submit', 'button', 'reset', 'image'].includes(element.type)
}
function isFormFieldControl(element: Element): boolean {
  if (element instanceof HTMLInputElement) return !isIgnoredInput(element)
  return element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || element instanceof HTMLOptionElement || element instanceof HTMLOptGroupElement
}

export function watchMutations(labelNodes: Set<Element>, invalidate: () => void, notify: () => void) {
  let stale = false
  let timer: ReturnType<typeof setTimeout> | undefined
  function touchesLabel(node: Node): boolean {
    let element = node instanceof Element ? node : node.parentElement
    while (element) {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return false
      if (labelNodes.has(element)) return true
      element = element.parentElement
    }
    return false
  }
  function relevant(record: MutationRecord): boolean {
    // Frameworks mirror current text answers into defaultValue/value attributes
    // (or textarea text). These are answers, not scan identity or labels. Keep
    // option/radio values watched; live preflight still checks current answers
    // and native constraints immediately before every write.
    if (record.type === 'attributes') {
      const target = record.target instanceof Element ? record.target : record.target.parentElement
      if (!target) return false
      if (isIgnoredInput(target)) return false
      if (record.attributeName === 'value' && (target instanceof HTMLInputElement && !['radio', 'checkbox'].includes(target.type) || target instanceof HTMLTextAreaElement)) return false
      if (isFormFieldControl(target)) return true
      if (target instanceof HTMLFieldSetElement && record.attributeName === 'disabled') return true
      if (target instanceof HTMLLabelElement && record.attributeName === 'for') return true
      if (labelNodes.has(target) && record.attributeName === 'id') return true
      return false
    }
    if (record.type === 'characterData') {
      const answerText = record.target.parentElement
      if (answerText?.closest('textarea') || answerText?.closest('input')) return false
      return Boolean(answerText?.closest('label,legend,option') || touchesLabel(record.target))
    }
    // ChildList mutations: only added or removed form controls alter the form structure.
    return [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element && (node.matches(formControlSelector) || Boolean(node.querySelector(formControlSelector))))
  }
  function process(records: MutationRecord[]) {
    // React temporarily clears/restores input names while updating controlled
    // state. Compare each attribute's first old value with its final value in
    // this synchronous batch, so a restored identity is not spuriously stale.
    const seen = new Map<Node, Set<string>>()
    const effective = records.filter((record) => {
      if (record.type !== 'attributes' || !record.attributeName || !(record.target instanceof Element)) return true
      const attributes = seen.get(record.target) ?? new Set<string>()
      if (attributes.has(record.attributeName)) return false
      attributes.add(record.attributeName); seen.set(record.target, attributes)
      return record.target.getAttribute(record.attributeName) !== record.oldValue
    })
    if (!stale && effective.some(relevant)) {
      stale = true
      invalidate()
      observer.disconnect()
      timer = setTimeout(notify, 150)
    }
  }
  const observer = new MutationObserver(process)
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true, attributeFilter: watchedAttributes })
  return {
    current() { process(observer.takeRecords()); return !stale },
    dispose() { observer.disconnect(); clearTimeout(timer) },
  }
}

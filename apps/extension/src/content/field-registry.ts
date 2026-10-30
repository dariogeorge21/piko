import { makeId } from '../features/scanner/scanner.messages'
import type { ScanField } from '../features/scanner/scanner.types'

export interface RegisteredField {
  metadata: ScanField; formId: string; owner: Node; elements: Element[]; signatures: string[]
  options: Map<string, { element: Element; signature: string }>
}
// Compare DOM identity and attributes, never collect current answers during scan.
export function identity(element: Element): string {
  const attributes = ['id', 'name', 'type', 'form', 'role', 'autocomplete', 'placeholder', 'aria-label', 'aria-labelledby', 'readonly', 'aria-readonly', 'required', 'aria-required', 'disabled', 'aria-disabled', 'multiple', 'min', 'max', 'step', 'minlength', 'maxlength', 'pattern', 'hidden', 'inert', 'aria-hidden']
  if (element.tagName === 'OPTION') attributes.push('value', 'label')
  // Do not copy arbitrary page data-* attributes or default text answers.
  return JSON.stringify([element.tagName, attributes.map((name) => [name, element.getAttribute(name)])])
}

/** DOM references never leave this isolated-world registry. */
export class FieldRegistry {
  readonly documentId = makeId('doc')
  private fieldIds = new WeakMap<Element, string>()
  private formIds = new WeakMap<Node, string>()
  private optionIds = new WeakMap<Element, string>()
  private current = new Map<string, Element[]>()
  private scanId: string | null = null
  private registered = new Map<string, RegisteredField>()
  constructor(private readonly owner: Document) {}
  begin(): string {
    this.scanId = makeId('scan')
    this.current.clear()
    this.registered.clear()
    return this.scanId
  }
  field(elements: Element[]): string {
    let id = this.fieldIds.get(elements[0])
    if (!id) id = makeId('fld')
    for (const element of elements) this.fieldIds.set(element, id)
    this.current.set(id, elements)
    return id
  }
  form(owner: Node): string {
    let id = this.formIds.get(owner)
    if (!id) { id = makeId('frm'); this.formIds.set(owner, id) }
    return id
  }
  option(element: Element): string {
    let id = this.optionIds.get(element)
    if (!id) { id = makeId('opt'); this.optionIds.set(element, id) }
    return id
  }
  resolve(fieldId: string, scanId: string): readonly Element[] | undefined {
    const elements = this.current.get(fieldId)
    return this.scanId === scanId && elements?.every((element) => element.isConnected && element.ownerDocument === this.owner) ? elements : undefined
  }
  register(metadata: ScanField, formId: string, owner: Node, elements: Element[], options: Element[]): void {
    this.registered.set(metadata.fieldId, { metadata, formId, owner, elements, signatures: elements.map(identity), options: new Map(options.map((element) => [this.option(element), { element, signature: identity(element) }])) })
  }
  entry(fieldId: string, scanId: string): RegisteredField | undefined {
    return this.resolve(fieldId, scanId) ? this.registered.get(fieldId) : undefined
  }
  invalidate(): void {
    this.scanId = null
    this.current.clear()
    this.registered.clear()
    this.fieldIds = new WeakMap()
    this.formIds = new WeakMap()
    this.optionIds = new WeakMap()
  }
}

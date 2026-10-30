import { isEmailField } from './name-intent'

/** Match only literal text or explicitly spoken email punctuation. The source
 * quote itself must still be an exact excerpt of the current transcript. */
export function supportedText(kind: string, value: string, quote: string, label: string = ''): boolean {
  const normalize = (text: string) => text.toLowerCase().trim().replace(/\s+/g, ' ')
  if (normalize(quote).includes(normalize(value))) return true
  if (kind !== 'email' && !isEmailField(label)) return false
  let text = normalize(quote)
  text = text.replace(/\b(?:at\s+the\s+rate(?:\s+of)?|at)\b/g, '@')
  for (const [word, symbol] of [['dot', '.'], ['underscore', '_'], ['dash', '-'], ['hyphen', '-']]) text = text.replace(new RegExp(`\\b${word}\\b`, 'g'), symbol)
  text = text.replace(/\s*([@._-])\s*/g, '$1')
  const cleanText = text.replace(/^(?:(?:(?:my|the)\s+)?(?:email|e-mail|mail)(?:\s+id|\s+address)?\s+(?:is|would be)|this is|it is|it['’]s|enter|please enter|put)\s+/i, '').replace(/^(?:please\s+)?(?:use\s+)?/i, '').trim()
  const match = cleanText.match(/^([a-z0-9\s._-]+)@([a-z0-9.-]+)$/i)
  if (match && match[2].includes('.')) {
    const candidate = `${match[1].replace(/\s+/g, '')}@${match[2].replace(/\.+$/, '')}`.toLowerCase()
    if (candidate === normalize(value)) return true
  }
  return (text.match(/[^\s@<>()[\]{},;:"]+@[a-z0-9.-]+/g) ?? []).some(candidate => candidate.replace(/\.+$/, '') === normalize(value))
}

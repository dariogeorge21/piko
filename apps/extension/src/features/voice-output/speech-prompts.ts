import type { ScanField } from '../scanner/scanner.types'
import type { InterpretResponse } from '../interpretation/interpretation.generated'
import { cleanLabel } from '../interpretation/name-intent'

const questions: Record<string, string> = {
  'full name': 'What is your full name?', name: 'What is your full name?',
  'email address': 'What is your email address?', email: 'What is your email address?',
  department: 'Which department should I use?', 'date of birth': 'What is your date of birth in year, month and day format?',
  'phone number': 'What is your phone number?',
}

/** Never interpolate webpage labels, model wording, quotes or personal values. */
export function speechPrompt(result: InterpretResponse, fields: ScanField[]): string {
  const id = result.clarifications[0]?.targetFieldIds[0] ?? result.missingFields[0]?.fieldId
  if (id) {
    const raw = fields.find(field => field.fieldId === id)?.label ?? ''
    const label = cleanLabel(raw).toLowerCase()
    return questions[label] ?? 'Please clarify your answer for this field.'
  }
  return result.updates.length ? 'Your answers are ready for review.' : 'I could not prepare any answers. Please try again.'
}

import type { Dispatch } from 'react'
import { ArrowRight, MessageSquareText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { AssistantAction } from '@/features/assistant/assistant.actions'
import type { AssistantState } from '@/features/assistant/assistant.types'
import { hasValue } from '@/features/assistant/assistant.reducer'
import { MessageBubble } from './MessageBubble'
import { VoiceControls } from './VoiceControls'

export function ConversationPanel({ state, dispatch }: { state: AssistantState; dispatch: Dispatch<AssistantAction> }) {
  const provided = state.proposals.filter(hasValue).length
  const missing = state.proposals.filter((proposal) => proposal.required && !hasValue(proposal))
  const target = state.proposals.find((proposal) => proposal.fieldId === state.answerFieldId)
  return <section aria-label="Conversation" className="space-y-4">
    <ol aria-label="Conversation messages" aria-live="polite" aria-relevant="additions" className="space-y-3">{state.messages.map((message) => <MessageBubble key={message.id} message={message} />)}</ol>
    <Button variant="outline" className="min-h-11 w-full rounded-xl bg-white hover:bg-emerald-50 text-emerald-950 font-medium border-emerald-950/15 transition-all shadow-2xs" disabled={state.demoAnswerAdded} onClick={() => dispatch({ type: 'ADD_DEMO_ANSWER' })}><MessageSquareText aria-hidden="true" className="size-4" />{state.demoAnswerAdded ? 'Sample answer added' : 'Use sample answer'}</Button>

    <form className="space-y-2.5 rounded-2xl border border-emerald-950/15 bg-white/95 p-4 shadow-2xs" onSubmit={(event) => { event.preventDefault(); dispatch({ type: 'ADD_TEXT_ANSWER' }) }}>
      <label htmlFor="answer-field" className="text-xs font-semibold text-emerald-950">Type an answer for</label>
      <select id="answer-field" value={state.answerFieldId} onChange={(event) => dispatch({ type: 'SET_ANSWER_FIELD', fieldId: event.target.value })} className="min-h-11 w-full rounded-xl border border-emerald-950/20 bg-white px-3 text-sm focus-visible:outline-2 focus-visible:outline-emerald-800">
        {state.proposals.map((proposal) => <option key={proposal.fieldId} value={proposal.fieldId}>{proposal.label}</option>)}
      </select>
      <label htmlFor="typed-answer" className="sr-only">Your answer</label>
      {target?.type === 'select' ? <select id="typed-answer" value={state.draftAnswer} onChange={(event) => dispatch({ type: 'SET_DRAFT_ANSWER', value: event.target.value })} className="min-h-11 w-full rounded-xl border border-emerald-950/20 bg-white px-3 text-sm" aria-invalid={Boolean(state.validationErrors.answer)} aria-describedby={`typed-answer-note${state.validationErrors.answer ? ' typed-answer-error' : ''}`}>
        <option value="">Choose an option</option>{target.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select> : <Textarea id="typed-answer" className="rounded-xl border-emerald-950/20 text-sm p-3 focus-visible:ring-emerald-800" value={state.draftAnswer} onChange={(event) => dispatch({ type: 'SET_DRAFT_ANSWER', value: event.target.value })} placeholder={`Enter ${target?.label.toLowerCase() ?? 'an answer'}`} maxLength={1024} rows={2} aria-invalid={Boolean(state.validationErrors.answer)} aria-describedby={`typed-answer-note${state.validationErrors.answer ? ' typed-answer-error' : ''}`} />}
      <p id="typed-answer-note" className="text-[11px] leading-5 text-muted-foreground">Use fictional details. Text updates only the field you choose; no AI interprets it.</p>
      {state.validationErrors.answer && <p id="typed-answer-error" role="alert" className="text-xs text-destructive font-medium">{state.validationErrors.answer}</p>}
      <Button type="submit" variant="secondary" className="min-h-11 w-full bg-emerald-950/10 hover:bg-emerald-950/15 text-emerald-950 font-semibold rounded-xl" disabled={!state.draftAnswer.trim()}>Add typed answer</Button>
    </form>

    <VoiceControls onAccept={text => dispatch({ type: 'ACCEPT_TRANSCRIPT', text })} />
    <p role="status" className="text-xs leading-5 text-muted-foreground bg-emerald-950/5 p-2.5 rounded-xl border border-emerald-950/10">{provided} of {state.proposals.length} answers prepared.{missing.length > 0 && ` Still missing: ${missing.map((proposal) => proposal.label).join(', ')}.`}</p>
    <Button className="primary-action" disabled={!provided} onClick={() => dispatch({ type: 'OPEN_REVIEW' })}>Review proposed values<ArrowRight aria-hidden="true" className="size-4" /></Button>
  </section>
}

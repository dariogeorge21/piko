import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { VoiceControls } from '@/components/assistant/VoiceControls'
import { useConnectionState } from '../local-service/connection.store'
import type { WorkflowState } from '../assistant/workflow.types'
import type { AssistantOrchestrator } from '../assistant/assistant.orchestrator'
import { questionQueue, nextQuestion } from '../assistant/question-queue'
import { liveContext } from '../assistant/workflow-guards'

export function InterpretationPanel({ state, controller }: { state: WorkflowState; controller: AssistantOrchestrator }) {
  const connection = useConnectionState()
  const busy = state.stage === 'interpreting'
  const active = liveContext(state) && !['filling', 'approving', 'stale'].includes(state.stage)
  const available = active && connection.status === 'paired'
  const queue = questionQueue(state), current = nextQuestion(state)
  return <section aria-label="Local answer interpretation" className="space-y-3.5 border-t border-emerald-950/10 pt-4">
    <div className="flex items-center justify-between">
      <h3 className="text-sm font-semibold text-emerald-950">Prepare answers with local Qwen</h3>
      <span role="status" className="text-[11px] font-medium text-emerald-800 bg-emerald-100/60 px-2 py-0.5 rounded-full">Conversation: {state.stage}</span>
    </div>
    <p className="text-xs leading-5 text-muted-foreground">Review your transcription or type an answer. Interpret sends this edited text and relevant confirmed session facts to your paired companion. Every value remains a proposal until you review and approve it.</p>
    {current && <div aria-label="Current question" className="space-y-2 rounded-xl border border-emerald-950/15 bg-emerald-50/50 p-3.5 text-xs shadow-2xs">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-900">Next Question</span>
        <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground hover:text-emerald-900" disabled={!active || busy} onClick={() => controller.skip(current.fieldId)}>Skip this question</Button>
      </div>
      <p className="font-medium text-emerald-950 text-sm leading-snug">{current.question}</p>
    </div>}
    {queue.length > 0 && <details className="rounded-lg bg-emerald-950/5 p-2.5 text-xs"><summary className="cursor-pointer font-medium text-emerald-900">Required or ambiguous questions · {queue.length}</summary><ul aria-label="Question queue" className="mt-2 space-y-1.5 text-xs pl-2 border-l border-emerald-950/15">{queue.map(item => <li key={item.fieldId} className="text-muted-foreground">{item.question}{item.skipped ? ' · Skipped; still unresolved' : ''}</li>)}</ul></details>}
    <VoiceControls onAccept={text => controller.transcript(text)} enabled={active && !busy} resetKey={`${state.session?.sessionId}:${state.scan?.inventory.scanId}:${state.mediaRevision}`} onStageChange={stage => controller.recordingStage(stage)} />
    <div className="space-y-1.5">
      <label htmlFor="interpret-transcript" className="text-xs font-medium text-emerald-950 block">Edited answer for this form</label>
      <Textarea id="interpret-transcript" rows={4} maxLength={4096} placeholder="Speak with microphone or type your details here naturally..." className="bg-white rounded-xl border-emerald-950/20 focus-visible:ring-emerald-800 p-3 text-sm leading-relaxed" disabled={!active} value={state.transcript} onChange={event => controller.transcript(event.target.value)} />
    </div>
    <Button variant="outline" className="min-h-11 w-full bg-emerald-900 hover:bg-emerald-800 text-white font-medium rounded-xl shadow-xs transition-all disabled:bg-muted disabled:text-muted-foreground" disabled={!available || busy || state.stage === 'transcribing' || !state.transcript.trim()} onClick={() => void controller.interpret()}>Interpret edited answer</Button>
    {!available && <p className="text-xs text-muted-foreground bg-muted/50 p-2.5 rounded-lg border border-border">Pair the local companion and keep a current scan to interpret answers. Manual entry remains available.</p>}
    {busy && <div className="space-y-2 rounded-lg bg-emerald-50 p-3 border border-emerald-950/10 text-center"><p role="status" className="text-xs font-medium text-emerald-900 animate-pulse">Interpreting locally…</p><Button variant="outline" size="sm" className="bg-white text-xs" onClick={() => controller.cancelInterpretation()}>Cancel interpretation</Button></div>}
    {state.messages.length > 0 && <div aria-label="Interpretation feedback" className="space-y-2 rounded-xl bg-white p-3 border border-emerald-950/15 text-xs shadow-2xs"><p role="status" className="font-semibold text-emerald-950">{Object.values(state.drafts).filter(draft => draft.source === 'model').length} validated proposals · Review and select fields below.</p>{Object.keys(state.evidence).length > 0 && <details className="pt-1"><summary className="cursor-pointer text-muted-foreground hover:text-emerald-900 font-medium">Source evidence for proposals</summary><ul className="mt-1.5 space-y-1 pl-2 border-l border-emerald-950/10">{Object.entries(state.evidence).map(([id, evidence]) => <li key={id}><span className="font-medium">{state.scan?.inventory.forms.flatMap(form => form.fields).find(field => field.fieldId === id)?.label}: </span><q className="text-muted-foreground">{evidence.quote}</q></li>)}</ul></details>}{state.clarifications.length > 0 && <><h4 className="font-semibold text-amber-900 pt-1">Please clarify</h4><ul className="space-y-1 pl-2">{state.clarifications.map((item, index) => <li key={index} className="text-amber-800">{item.question}</li>)}</ul></>}{queue.length > 0 && <><h4 className="font-semibold text-destructive pt-1">Required information still missing</h4><ul className="space-y-1 pl-2">{queue.map(item => <li key={item.fieldId} className="text-destructive/90">{item.question}</li>)}</ul></>}</div>}
    {state.messages.length > 0 && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer font-medium py-1">Current conversation · temporary</summary><ol aria-label="Live conversation messages" className="mt-2 space-y-2 bg-emerald-950/5 p-3 rounded-lg">{state.messages.map((message, index) => <li key={index}><strong>{message.role === 'user' ? 'You' : 'Assistant'}: </strong>{message.text}</li>)}</ol></details>}
    {state.transcript && <Button variant="ghost" size="sm" className="min-h-8 w-full text-xs text-muted-foreground hover:text-destructive" disabled={!active} onClick={() => controller.discard()}>Discard interpreted answers</Button>}
  </section>
}

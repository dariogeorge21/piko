import { useState } from 'react'
import { Check, Mic, Volume2, VolumeX } from 'lucide-react'
import { AppShell } from '@/components/layout/AppShell'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useGuidedAssistant } from '@/features/assistant/use-guided-assistant'
import { displayAnswer } from '@/features/assistant/guided-assistant'
import { validDraft } from '@/features/assistant/conversation-selectors'
import { GuidedVoiceInput } from '@/features/voice-input/GuidedVoiceInput'
import { useVoiceState } from '@/features/voice-output/voice.store'
import { useConnectionState, publishConnection } from '@/features/local-service/connection.store'
import { connectionAction } from '@/features/local-service/connection.service'

export default function App() {
  const { state, controller } = useGuidedAssistant()
  const connection = useConnectionState()
  const [answer, setAnswer] = useState('')
  const voice = useVoiceState(), field = controller.currentField(), fields = controller.fields()
  const active = ['answer', 'confirm'].includes(state.phase)
  const busy = ['starting', 'summary', 'interpreting', 'filling'].includes(state.phase)
  const verified = fields.filter(item => state.workflow.verified.includes(item.fieldId))
  const missing = fields.filter(item => item.required && !state.workflow.verified.includes(item.fieldId))
  const toConfirm = fields.filter(item => state.workflow.drafts[item.fieldId]?.selected || (!state.workflow.verified.includes(item.fieldId) && !state.workflow.skipped.includes(item.fieldId) && validDraft(item, state.workflow.drafts[item.fieldId])))
  const send = () => { const text = answer; setAnswer(''); void controller.answer(text) }
  return <AppShell>
    <section className="space-y-4" aria-label="Form assistant">
      <div className="space-y-1"><h1 className="text-2xl font-semibold tracking-tight">Let’s fill your form.</h1><p className="text-sm text-muted-foreground">One question at a time. Every answer is yours to confirm.</p></div>
      {state.workflow.scan && <p className="break-all text-xs text-muted-foreground">{state.workflow.scan.inventory.origin} · {verified.length} of {fields.length} fields checked</p>}
      <div aria-label="Assistant conversation" className="space-y-3 rounded-2xl border border-emerald-950/15 bg-white p-4 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">Piko</p>
        <p role="status" aria-live="polite" className="text-base leading-relaxed">{busy && !['synthesizing', 'playing'].includes(voice.output) ? state.phase === 'starting' ? 'Connecting and reading your form…' : state.phase === 'summary' ? 'Analysing the form…' : state.phase === 'filling' ? 'Filling the answer you confirmed…' : 'Checking your answer…' : state.message}</p>
        {state.heard && <p aria-label="Last transcript" className="rounded-lg bg-emerald-50 p-2 text-sm"><span className="font-medium">You said: </span>{state.heard}</p>}
        {state.phase !== 'confirm' && field && <p className="text-xs text-muted-foreground">{field.label}{field.required ? /required/i.test(field.label) ? '' : ' · Required' : ' · Optional'}</p>}
        {state.phase === 'confirm' && toConfirm.length > 0 && (
          <div aria-label="Answer confirmation" className="space-y-3 rounded-xl border border-emerald-800/25 bg-emerald-50 p-3">
            <p className="text-xs font-medium">Fill {toConfirm.length > 1 ? 'these answers' : 'this answer'} on {state.workflow.scan?.inventory.origin}?</p>
            {toConfirm.length === 1 ? (
              <div>
                <p className="text-xs text-muted-foreground">{toConfirm[0].label}</p>
                <p className="break-words text-lg font-semibold">{displayAnswer(toConfirm[0], state.workflow)}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {toConfirm.map(item => (
                  <div key={item.fieldId} className="flex items-center justify-between gap-2 rounded-lg bg-white/90 p-2 text-sm border border-emerald-950/10">
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground font-medium">{item.label}</p>
                      <p className="font-semibold break-words text-base">{displayAnswer(item, state.workflow)}</p>
                    </div>
                    <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground shrink-0" onClick={() => { setAnswer(''); void controller.correct(true, item.fieldId) }}>Change</Button>
                  </div>
                ))}
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Button className="min-h-11" onClick={() => void controller.confirm()}><Check aria-hidden="true" />{toConfirm.length > 1 ? 'Yes, fill form' : 'Yes, fill it'}</Button>
              <Button className="min-h-11" variant="outline" onClick={() => { setAnswer(''); void controller.correct() }}>Change answer</Button>
            </div>
          </div>
        )}
        {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
        {state.phase === 'interpreting' && <Button variant="ghost" onClick={() => controller.cancelAnswer()}>Cancel answer</Button>}
        {voice.error && <p role="alert" className="text-sm text-destructive">{voice.error === 'speech-playback-blocked' ? 'Chrome paused playback. Click Play question to hear it.' : 'Speech is unavailable. You can read the question and type your answer.'}</p>}
        {state.phase === 'idle' || state.phase === 'error' || state.phase === 'stale' ? <div className="space-y-2"><Button className="primary-action" onClick={() => void controller.start(true)}><Mic aria-hidden="true" />{state.phase === 'stale' ? 'Scan form again' : 'Start voice assistant'}</Button><Button variant="ghost" className="w-full" onClick={() => void controller.start(false)}>Use text instead</Button><p className="text-xs leading-5 text-muted-foreground">Voice mode reads back your answers for confirmation. Chrome asks for microphone permission the first time.</p></div> : null}
        {active && <>
          {state.voice && <GuidedVoiceInput enabled={active} listen={state.listen} turn={state.turn} onRecording={() => controller.recording()} onTranscript={(text, turn) => void controller.answer(text, turn)} />}
          <label htmlFor="answer" className="block text-xs font-medium">{state.phase === 'confirm' ? 'Confirm or correct your answer' : 'Your answer'}</label>
          <Textarea id="answer" value={answer} maxLength={4096} rows={2} placeholder={state.phase === 'confirm' ? 'Yes, or type a correction…' : 'You can also type here…'} onChange={event => { controller.typing(); setAnswer(event.target.value) }} />
          <Button className="w-full" variant="outline" disabled={!answer.trim()} onClick={send}>Send answer</Button>
          <div className="flex justify-between gap-2">{state.phase !== 'confirm' && <Button size="sm" variant="ghost" onClick={() => void controller.skip()}>Skip this field</Button>}{state.voice ? <Button size="sm" variant="ghost" onClick={() => controller.mute()}><VolumeX aria-hidden="true" />Use text</Button> : null}</div>
          {state.error && field && <div className="space-y-2 border-t pt-3"><p className="text-xs">You can provide this field’s value directly.</p>{field.options.length ? <select aria-label="Direct field value" className="w-full rounded border p-2" value={answer} onChange={event => { controller.typing(); setAnswer(event.target.value) }}><option value="">Choose a value…</option>{field.options.filter(option => !option.disabled).map(option => <option key={option.optionId} value={option.optionId}>{option.label}</option>)}</select> : null}<Button variant="outline" className="w-full" disabled={!answer.trim()} onClick={() => void controller.manual(answer)}>Review this value</Button>{state.workflow.outcome?.results.some(result => result.reason === 'existing-value') && <Button variant="outline" className="w-full" onClick={() => void controller.prepareConfirmation(true)}>Review replacing the existing answer</Button>}</div>}
        </>}
        {state.voice && state.phase !== 'idle' && !busy && <Button variant="ghost" size="sm" onClick={() => void controller.replay()}><Volume2 aria-hidden="true" />Play question</Button>}
        {voice.output === 'synthesizing' || voice.output === 'playing' ? <p role="status" className="text-xs text-emerald-800">{voice.output === 'synthesizing' ? 'Preparing voice…' : 'Speaking… Microphone paused.'}</p> : null}
      </div>
      {['complete', 'ready'].includes(state.phase) && <section aria-label="Final form review" className="space-y-3 rounded-2xl border bg-white p-4"><h2 className="font-semibold">Review your form</h2><ul className="divide-y text-sm">{verified.map(item => <li key={item.fieldId} className="py-2"><span className="font-medium">{item.label}: </span>{displayAnswer(item, state.workflow)}</li>)}</ul><p className="text-sm">{missing.length ? `${missing.length} required fields still need your attention.` : 'The supported required fields were verified.'} Check the page and any manual-only fields, then submit it yourself.</p>{state.phase === 'complete' ? <Button className="w-full" onClick={() => void controller.finishReview()}>Finish review</Button> : <p role="status" className="text-sm font-medium text-emerald-900">Review confirmed · Submission is yours</p>}</section>}
      {state.phase !== 'idle' && <Button className="w-full" variant="ghost" disabled={state.phase === 'filling'} onClick={() => { setAnswer(''); void controller.end() }}>End session</Button>}
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer py-2">Connection</summary><div className="space-y-2 rounded-lg border p-3"><p>{connection.status === 'paired' ? 'Companion connected' : 'Start the local companion on 127.0.0.1:8765.'}</p><ul aria-label="Local service capabilities"><li>Whisper: {connection.capabilities?.transcription ?? 'not checked'}</li><li>Piper: {connection.capabilities?.speech_synthesis ?? 'not checked'}</li><li>Ollama: {connection.capabilities?.inference ?? 'not checked'}</li></ul><Button variant="outline" size="sm" disabled={busy} onClick={() => void connectionAction({ type: 'PIKO_SERVICE_PAIR' }).then(reply => publishConnection(reply.state))}>Check connection</Button></div></details>
    </section>
  </AppShell>
}

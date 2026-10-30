import { useEffect, useRef, useState } from 'react'
import { Mic, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RecordingController } from './recording.controller'
import { initialRecording } from './recording.types'
import { uploadRecording } from './audio-transport'
import { watchSilence } from './silence-detector'
import { useVoiceState } from '../voice-output/voice.store'

export function GuidedVoiceInput({ enabled, listen, turn, onTranscript, onRecording }: { enabled: boolean; listen: boolean; turn: number; onTranscript: (text: string, turn: number) => void; onRecording: () => void }) {
  const [state, setState] = useState(initialRecording)
  const [controller] = useState(() => new RecordingController(setState, uploadRecording, { watchSilence }))
  const ticket = useRef(turn), delivered = useRef<string | null>(null)
  const voice = useVoiceState(), speaking = ['playing', 'synthesizing'].includes(voice.output)
  const callbacks = useRef({ onTranscript, onRecording })
  useEffect(() => { callbacks.current = { onTranscript, onRecording } }, [onTranscript, onRecording])
  useEffect(() => { controller.reset(); delivered.current = null }, [controller, turn])
  useEffect(() => {
    if (enabled && listen && !speaking && ['idle', 'error', 'no-speech'].includes(controller.snapshot.stage)) {
      ticket.current = turn; callbacks.current.onRecording(); void controller.start()
    }
  }, [controller, enabled, listen, speaking, turn])
  useEffect(() => { if (!enabled) controller.reset() }, [controller, enabled])
  useEffect(() => {
    if (state.stage === 'transcript-ready' && delivered.current !== state.transcript) {
      delivered.current = state.transcript; callbacks.current.onTranscript(state.transcript, ticket.current)
    }
  }, [state.stage, state.transcript])
  useEffect(() => { const hide = () => controller.reset(false); window.addEventListener('pagehide', hide); return () => { window.removeEventListener('pagehide', hide); hide() } }, [controller])
  return <div className="space-y-2">
    {state.stage === 'recording' ? <><p role="status" className="text-center text-sm text-emerald-900">Listening… {Math.floor(state.elapsedMs / 1000)}s</p><Button className="w-full min-h-12" onClick={() => controller.stop()}><Square aria-hidden="true" />Stop recording</Button><p className="text-center text-xs text-muted-foreground">Pause when you finish. Recording stops automatically.</p></>
      : state.stage === 'processing' ? <p role="status" className="py-3 text-center text-sm">Transcribing with Whisper…</p>
      : <Button className="w-full min-h-12" variant="outline" disabled={!enabled || speaking || state.stage === 'requesting-permission'} onClick={() => { delivered.current = null; ticket.current = turn; callbacks.current.onRecording(); void controller.start() }}><Mic aria-hidden="true" />{state.stage === 'requesting-permission' ? 'Opening microphone…' : 'Speak answer'}</Button>}
    {state.stage === 'error' && <p role="alert" className="text-sm text-destructive">{state.error === 'microphone-denied' ? 'Chrome blocked the microphone. Allow microphone access for Piko and retry.' : state.error === 'microphone-missing' ? 'No microphone was found. Connect a microphone or type your answer.' : 'Voice input failed. Try again or type your answer.'}</p>}
    {state.stage === 'no-speech' && <p role="status" className="text-sm">No speech detected. Speak again or type your answer.</p>}
  </div>
}

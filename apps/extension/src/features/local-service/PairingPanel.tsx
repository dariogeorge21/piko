import { Button } from '@/components/ui/button'
import type { ConnectionState } from './connection.types'
import type { ConnectionAction } from './connection.service'

export function PairingPanel({ state, busy, act }: { state: ConnectionState; busy: boolean; act: (action: ConnectionAction) => Promise<void> }) {
  const isConnected = state.status === 'paired'

  return <details className="rounded-xl border border-emerald-950/15 bg-white/90 shadow-2xs p-3.5 text-xs transition-all group">
    <summary className="cursor-pointer font-medium select-none flex items-center justify-between text-emerald-950 hover:text-emerald-800">
      <span className="flex items-center gap-2">
        <span className={`size-2 rounded-full ${isConnected ? 'bg-emerald-600' : 'bg-amber-500'}`} />
        Local service connection
      </span>
      <span className="text-[10px] font-normal text-muted-foreground">{isConnected ? 'Connected' : 'Disconnected'}</span>
    </summary>
    <div className="mt-3.5 space-y-3 pt-3 border-t border-emerald-950/10">
      <div className="rounded-lg bg-emerald-950/5 p-2.5 text-[11px] leading-5 text-emerald-950">
        <p>Service: <code className="bg-white/80 px-1 py-0.5 rounded font-mono text-emerald-900">127.0.0.1:8765</code>. Direct connection (no pairing code required).</p>
      </div>

      {!isConnected ? (
        <Button
          className="min-h-10 w-full primary-action text-sm"
          disabled={busy || state.disconnectPending}
          onClick={() => void act({ type: 'PIKO_SERVICE_PAIR' })}
        >
          {busy ? 'Connecting…' : 'Connect to companion'}
        </Button>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="flex-1 bg-white text-xs min-h-9" disabled={busy} onClick={() => void act({ type: 'PIKO_SERVICE_PING' })}>Ping service</Button>
          <Button variant="outline" className="flex-1 bg-white text-xs min-h-9" disabled={busy} onClick={() => void act({ type: 'PIKO_SERVICE_CAPABILITIES' })}>Check capabilities</Button>
        </div>
      )}

      <Button
        variant="outline"
        className="min-h-10 w-full bg-white hover:bg-emerald-50 text-emerald-950 font-medium transition-colors"
        disabled={busy}
        onClick={() => void act({ type: 'PIKO_SERVICE_HEALTH' })}
      >
        {state.disconnectPending ? 'Retry pending disconnect' : 'Check service health'}
      </Button>

      {isConnected && (
        <Button
          variant="outline"
          className="min-h-9 w-full bg-white text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/5"
          disabled={busy}
          onClick={() => void act({ type: 'PIKO_SERVICE_DISCONNECT' })}
        >
          Disconnect service
        </Button>
      )}

      {state.capabilities && <ul aria-label="Local service capabilities" className="space-y-1.5 rounded-lg bg-emerald-950/5 p-2.5 text-[11px]">
        <li className="flex justify-between font-medium"><span>Inference:</span> <span className="capitalize text-emerald-900">{state.capabilities.inference.replace('_', ' ')}</span></li>
        <li className="flex justify-between font-medium"><span>Transcription:</span> <span className="capitalize text-emerald-900">{state.capabilities.transcription.replace('_', ' ')}</span></li>
        <li className="flex justify-between font-medium"><span>Speech synthesis:</span> <span className="capitalize text-emerald-900">{state.capabilities.speech_synthesis.replace('_', ' ')}</span></li>
      </ul>}

      {state.checkedAt !== null && <p className="text-[10px] text-muted-foreground">Last verified: {new Date(state.checkedAt).toLocaleTimeString()}</p>}
      <p className="text-[10px] leading-4 text-muted-foreground border-t border-emerald-950/5 pt-2">Direct connection connects directly to your local companion service without security codes. Only explicitly recorded audio is uploaded for transcription. Clicking Interpret sends your edited answer and eligible field metadata to the local companion. Play aloud sends the visible assistant message for local speech generation. No cloud inference is used.</p>
    </div>
  </details>
}

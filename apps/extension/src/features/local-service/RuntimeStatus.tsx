import { useCallback, useEffect, useRef, useState } from 'react'
import { PlugZap } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { PairingPanel } from './PairingPanel'
import { connectionAction, type ConnectionAction } from './connection.service'
import { type ConnectionError } from './connection.types'
import { publishConnection, useConnectionState } from './connection.store'

const errors: Record<ConnectionError, string> = {
  'service-unavailable': 'The companion service is unavailable. Start it on 127.0.0.1:8765, then check again.',
  timeout: 'The local service request timed out. Check that the service is responding.',
  'pairing-rejected': 'Connection was rejected by the service. Ensure the companion service is running.',
  'rate-limited': 'Too many connection attempts. Wait a moment before trying again.',
  'session-expired': 'The session ended or the service restarted. Connect again to resume.',
  'invalid-response': 'The service returned an invalid response. Check the companion version before retrying.',
  'unsupported-protocol': 'The service uses an unsupported protocol version. Update the extension and companion together.',
  'unsupported-origin': 'The service rejected this extension origin. Restart the companion.',
  'disconnect-unconfirmed': 'Disconnected locally. You can reconnect anytime.',
  busy: 'A connection operation is already running. Wait for it to finish.',
  'storage-unavailable': 'Temporary extension session storage is unavailable. Reload the extension before connecting.',
}
const titles = { disconnected: 'Local companion disconnected', available: 'Companion available', paired: 'Companion connected', expired: 'Companion disconnected', unavailable: 'Companion unavailable' }
export function RuntimeStatus() {
  const state = useConnectionState()
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const mounted = useRef(false)
  const act = useCallback(async (action: ConnectionAction) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    const response = await connectionAction(action)
    if (mounted.current) { publishConnection(response.state); setBusy(false) }
    inFlight.current = false
  }, [])
  useEffect(() => {
    mounted.current = true
    void act({ type: 'PIKO_SERVICE_STATUS' })
    return () => { mounted.current = false }
  }, [act])
  useEffect(() => {
    if (state.status !== 'paired') return
    // Only authenticated sessions are rechecked. No automatic pairing attempts.
    const timer = setInterval(() => void act({ type: 'PIKO_SERVICE_STATUS' }), 30_000)
    const expiry = setTimeout(() => void act({ type: 'PIKO_SERVICE_STATUS' }), Math.max(0, (state.expiresAt ?? 0) - Date.now()))
    return () => { clearInterval(timer); clearTimeout(expiry) }
  }, [state.status, state.expiresAt, act])
  return <section aria-label="Local companion connection" className="space-y-3">
    <Alert role="status" aria-live="polite" className="border-emerald-950/15 bg-white/90 shadow-2xs rounded-xl p-3.5">
      <PlugZap aria-hidden="true" className={`size-4 ${state.status === 'paired' ? 'text-emerald-700' : 'text-amber-600'}`} />
      <AlertTitle className="font-semibold text-emerald-950">{titles[state.status]}</AlertTitle>
      <AlertDescription className="text-xs leading-5 text-muted-foreground">{busy ? 'Checking local connection…' : 'Voice input, interpretation and optional spoken responses use your local companion. Text remains available.'}</AlertDescription>
    </Alert>
    {state.error && <p role="alert" className="text-xs leading-5 text-destructive font-medium px-1">{errors[state.error]}</p>}
    <PairingPanel state={state} busy={busy} act={act} />
  </section>
}

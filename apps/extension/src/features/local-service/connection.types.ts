export const SERVICE_ORIGIN = 'http://127.0.0.1:8765'
export const SESSION_KEY = 'piko.localService.session.v1'
export const REQUEST_TIMEOUT_MS = 3000
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000
export type ConnectionError = 'service-unavailable' | 'timeout' | 'pairing-rejected' | 'rate-limited' | 'session-expired' | 'invalid-response' | 'unsupported-protocol' | 'unsupported-origin' | 'disconnect-unconfirmed' | 'busy' | 'storage-unavailable'
export interface Capabilities { protocol_version: 1; inference: 'not_integrated' | 'ready' | 'unavailable'; transcription: 'not_integrated' | 'ready' | 'unavailable'; speech_synthesis: 'not_integrated' | 'ready' | 'unavailable'; speech_synthesis_detail?: 'speech-configuration-invalid' | 'speech-voice-missing' | 'speech-voice-invalid' | 'speech-unavailable' | null }
export interface ConnectionState {
  status: 'disconnected' | 'available' | 'paired' | 'expired' | 'unavailable'
  checkedAt: number | null
  expiresAt: number | null
  capabilities: Capabilities | null
  error: ConnectionError | null
  disconnectPending: boolean
}
export type ConnectionRequest = { requestId: string } & (
  | { type: 'PIKO_SERVICE_STATUS' | 'PIKO_SERVICE_HEALTH' | 'PIKO_SERVICE_PING' | 'PIKO_SERVICE_CAPABILITIES' | 'PIKO_SERVICE_DISCONNECT' }
  | { type: 'PIKO_SERVICE_PAIR'; code?: string }
)
export interface ConnectionResponse { requestId: string; ok: boolean; state: ConnectionState }
export const initialConnection: ConnectionState = { status: 'disconnected', checkedAt: null, expiresAt: null, capabilities: null, error: null, disconnectPending: false }

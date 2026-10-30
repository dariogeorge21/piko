import { isSpeechText, isSpeechWav } from '../features/voice-output/speech.validation'
import { MAX_SPEECH_BYTES, SpeechError, speechErrors } from '../features/voice-output/speech.types'
import { InterpretationError, interpretationErrors, isInterpretResponse } from '../features/interpretation/interpretation.validation'
import type { InterpretRequest, InterpretResponse } from '../features/interpretation/interpretation.generated'
import { hasKeys, isRecord } from '../features/scanner/scanner.messages'
import { initialConnection, REQUEST_TIMEOUT_MS, SERVICE_ORIGIN, SESSION_KEY, SESSION_TTL_MS } from '../features/local-service/connection.types'
import type { ConnectionError, ConnectionRequest, ConnectionResponse, ConnectionState } from '../features/local-service/connection.types'
import { isCapabilities } from '../features/local-service/connection.validation'
import { isTranscript } from '../features/voice-input/transcription.validation'
import { MAX_AUDIO_BYTES, VoiceInputError, voiceErrors, type Transcript } from '../features/voice-input/transcription.types'

interface StoredSession { token: string; origin: string; expiresAt: number; pendingRevocation: boolean }
class ServiceError extends Error { constructor(readonly code: ConnectionError) { super(code) } }
function failed(code: ConnectionError): never { throw new ServiceError(code) }

export class ConnectionManager {
  private state: ConnectionState = { ...initialConnection }
  private busy = false
  private initialized = false
  private interpretationController: AbortController | null = null
  private speechController: AbortController | null = null
  private audioController: AbortController | null = null
  constructor(private readonly http: typeof fetch = globalThis.fetch.bind(globalThis), private readonly now = Date.now, private readonly timeoutMs = REQUEST_TIMEOUT_MS) {}

  private async prepare() {
    if (this.initialized) return
    // TRUSTED_CONTEXTS excludes content scripts. UI code never reads this area
    // or receives a token; all access and requests stay in this worker module.
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
    this.initialized = true
  }
  private async saved(): Promise<StoredSession | null> {
    const value: unknown = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY]
    if (value === undefined) return null
    if (!isRecord(value) || !hasKeys(value, ['token', 'origin', 'expiresAt', 'pendingRevocation']) || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token) || value.origin !== chrome.runtime.getURL('').replace(/\/$/, '') || !Number.isSafeInteger(value.expiresAt) || typeof value.pendingRevocation !== 'boolean') {
      await this.clear(); return null
    }
    return value as unknown as StoredSession
  }
  private async clear() { await chrome.storage.session.remove(SESSION_KEY) }
  private async save(session: StoredSession) { await chrome.storage.session.set({ [SESSION_KEY]: session }) }

  async transcribeAudio(audio: Blob, signal: AbortSignal): Promise<Transcript> {
    if (this.audioController) throw new VoiceInputError('transcription-busy')
    if (!audio.size) throw new VoiceInputError('empty-audio')
    if (audio.size > MAX_AUDIO_BYTES) throw new VoiceInputError('audio-too-large')
    const controller = new AbortController()
    this.audioController = controller
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, 28_000)
    try {
      if (signal.aborted) throw new VoiceInputError('request-cancelled')
      await this.prepare()
      const session = await this.saved()
      if (!session || session.pendingRevocation || this.now() >= session.expiresAt) throw new VoiceInputError('session-expired')
      const form = new FormData()
      form.append('file', audio, 'recording')
      const response = await this.http(`${SERVICE_ORIGIN}/v1/transcribe`, { method: 'POST', body: form, headers: { Authorization: `Bearer ${session.token}`, 'X-Piko-Extension-Origin': session.origin }, signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error', mode: 'cors' })
      if (response.status === 401 || response.status === 403) {
        await this.clear()
        this.state = { ...initialConnection, status: 'expired', error: 'session-expired' }
        throw new VoiceInputError('session-expired')
      }
      if (!response.body || response.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new VoiceInputError('invalid-response')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let length = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          length += value.length
          if (length > 32768) { await reader.cancel(); throw new VoiceInputError('invalid-response') }
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      let result: unknown
      try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new VoiceInputError('invalid-response') }
      if (!response.ok) {
        if (isRecord(result) && hasKeys(result, ['error']) && typeof result.error === 'string' && (voiceErrors as readonly string[]).includes(result.error)) throw new VoiceInputError(result.error as VoiceInputError['code'])
        throw new VoiceInputError('transcription-failed')
      }
      if (!isTranscript(result)) throw new VoiceInputError('invalid-response')
      const current = await this.saved()
      if (!current || current.token !== session.token || current.pendingRevocation || this.now() >= current.expiresAt) throw new VoiceInputError('session-expired')
      return result
    } catch (error) {
      if (error instanceof VoiceInputError) throw error
      throw new VoiceInputError(controller.signal.aborted ? signal.aborted ? 'request-cancelled' : 'transcription-timeout' : 'service-unavailable')
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (this.audioController === controller) this.audioController = null
    }
  }

  async synthesizeSpeech(text: string, signal: AbortSignal): Promise<Uint8Array> {
    if (!isSpeechText(text)) throw new SpeechError('invalid-speech-text')
    if (this.speechController) throw new SpeechError('speech-busy')
    const controller = new AbortController()
    this.speechController = controller
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, 28_000)
    try {
      if (signal.aborted) throw new SpeechError('speech-cancelled')
      await this.prepare()
      const session = await this.saved()
      if (!session || session.pendingRevocation || this.now() >= session.expiresAt) throw new SpeechError('session-expired')
      const response = await this.http(`${SERVICE_ORIGIN}/v1/synthesize`, {
        method: 'POST', body: JSON.stringify({ text }), headers: { Authorization: `Bearer ${session.token}`, 'X-Piko-Extension-Origin': session.origin, 'Content-Type': 'application/json' },
        signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error', mode: 'cors',
      })
      if (response.status === 401 || response.status === 403) {
        await this.clear()
        this.state = { ...initialConnection, status: 'expired', error: 'session-expired' }
        throw new SpeechError('session-expired')
      }
      const contentType = response.headers.get('content-type')?.split(';')[0].trim()
      if (!response.body || contentType !== (response.ok ? 'audio/wav' : 'application/json')) throw new SpeechError('invalid-speech-audio')
      const maximum = response.ok ? MAX_SPEECH_BYTES : 4096
      if (Number(response.headers.get('content-length') ?? 0) > maximum) throw new SpeechError('speech-audio-too-large')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let length = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          length += value.length
          if (length > maximum) { await reader.cancel(); throw new SpeechError('speech-audio-too-large') }
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
      const audio = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.length }
      if (!response.ok) {
        let error: unknown
        try { error = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(audio)) } catch { throw new SpeechError('speech-synthesis-failed') }
        if (isRecord(error) && hasKeys(error, ['error']) && (speechErrors as readonly unknown[]).includes(error.error)) throw new SpeechError(error.error as SpeechError['code'])
        throw new SpeechError('speech-synthesis-failed')
      }
      if (!isSpeechWav(audio)) throw new SpeechError('invalid-speech-audio')
      const current = await this.saved()
      if (!current || current.token !== session.token || current.pendingRevocation || this.now() >= current.expiresAt) throw new SpeechError('session-expired')
      if (controller.signal.aborted) throw new SpeechError('speech-cancelled')
      return audio
    } catch (error) {
      if (error instanceof SpeechError) throw error
      throw new SpeechError(controller.signal.aborted ? signal.aborted ? 'speech-cancelled' : 'speech-timeout' : 'service-unavailable')
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (this.speechController === controller) this.speechController = null
    }
  }

  async interpret(payload: InterpretRequest, signal: AbortSignal): Promise<InterpretResponse> {
    return await this.inference(payload, signal, 'interpret') as InterpretResponse
  }
  async summarize(payload: SummaryRequest, signal: AbortSignal): Promise<FormSummary> {
    return await this.inference({ ...payload, transcript: 'Form summary', knownFacts: [] }, signal, 'summary') as FormSummary
  }
  private async inference(payload: InterpretRequest, signal: AbortSignal, mode: 'interpret' | 'summary'): Promise<InterpretResponse | FormSummary> {
    if (this.interpretationController) throw new InterpretationError('interpretation-busy')
    const controller = new AbortController()
    this.interpretationController = controller
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, 125_000)
    try {
      if (signal.aborted) throw new InterpretationError('request-cancelled')
      await this.prepare()
      const session = await this.saved()
      if (!session || session.pendingRevocation || this.now() >= session.expiresAt) throw new InterpretationError('session-expired')
      const body = JSON.stringify(mode === 'summary' ? { scanId: payload.scanId, fields: payload.fields } : payload)
      if (new TextEncoder().encode(body).length > 131072) throw new InterpretationError('body_too_large')
      const response = await this.http(`${SERVICE_ORIGIN}/v1/${mode}`, {
        method: 'POST', body, headers: { Authorization: `Bearer ${session.token}`, 'X-Piko-Extension-Origin': session.origin, 'Content-Type': 'application/json' },
        signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error', mode: 'cors',
      })
      if (response.status === 401 || response.status === 403) {
        await this.clear()
        this.state = { ...initialConnection, status: 'expired', error: 'session-expired' }
        throw new InterpretationError('session-expired')
      }
      if (!response.body || response.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new InterpretationError('invalid-response')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.length
          if (size > 131072) { await reader.cancel(); throw new InterpretationError('invalid-response') }
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      let value: unknown
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new InterpretationError('invalid-response') }
      if (!response.ok) {
        if (isRecord(value) && hasKeys(value, ['error']) && (interpretationErrors as readonly unknown[]).includes(value.error)) throw new InterpretationError(value.error as InterpretationError['code'])
        throw new InterpretationError('invalid-response')
      }
      if (!(mode === 'summary' ? isFormSummary(value, payload.scanId) : isInterpretResponse(value, payload))) throw new InterpretationError('invalid-response')
      const current = await this.saved()
      if (!current || current.token !== session.token || current.pendingRevocation || this.now() >= current.expiresAt) throw new InterpretationError('session-expired')
      if (controller.signal.aborted) throw new InterpretationError('request-cancelled')
      return value as InterpretResponse | FormSummary
    } catch (error) {
      if (error instanceof InterpretationError) throw error
      throw new InterpretationError(controller.signal.aborted ? signal.aborted ? 'request-cancelled' : 'interpretation-timeout' : 'service-unavailable')
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (this.interpretationController === controller) this.interpretationController = null
    }
  }

  private async request(path: '/health' | '/pair' | '/ping' | '/capabilities' | '/session', method: 'GET' | 'POST' | 'DELETE' = 'GET', token?: string, code?: string): Promise<Record<string, unknown>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      // Privileged Chrome extension GETs can omit Origin even in CORS mode.
      // Declare our runtime-derived origin; the server independently requires
      // the token and rejects disagreement with any browser-supplied Origin.
      const headers: Record<string, string> = { 'X-Piko-Extension-Origin': chrome.runtime.getURL('').replace(/\/$/, '') }
      if (token) headers.Authorization = `Bearer ${token}`
      if (path === '/pair' || code !== undefined) headers['Content-Type'] = 'application/json'
      const requestBody = path === '/pair' ? JSON.stringify({ protocol_version: 1, ...(code !== undefined ? { code } : {}) }) : undefined
      const response = await this.http(`${SERVICE_ORIGIN}/v1${path}`, {
        method, headers, ...(requestBody ? { body: requestBody } : {}),
        signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error', mode: 'cors',
      })
      if (response.status === 401) failed(path === '/pair' ? 'pairing-rejected' : 'session-expired')
      if (response.status === 403) failed('unsupported-origin')
      if (response.status === 429) failed('rate-limited')
      if (response.status === 426) failed('unsupported-protocol')
      if (response.status >= 500) failed('service-unavailable')
      if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json' || Number(response.headers.get('content-length') ?? 0) > 4096 || !response.body) failed('invalid-response')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let length = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          length += value.length
          if (length > 4096) { await reader.cancel(); failed('invalid-response') }
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      let value: unknown
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { failed('invalid-response') }
      if (!isRecord(value)) failed('invalid-response')
      if (typeof value.protocol_version === 'number' && value.protocol_version !== 1) failed('unsupported-protocol')
      if (value.protocol_version !== 1) failed('invalid-response')
      return value
    } catch (error) {
      if (error instanceof ServiceError) throw error
      return failed(controller.signal.aborted ? 'timeout' : 'service-unavailable')
    } finally { clearTimeout(timer) }
  }
  private async verify(session: StoredSession, capabilities = true) {
    if (this.now() >= session.expiresAt) failed('session-expired')
    if (capabilities) {
      const value = await this.request('/capabilities', 'GET', session.token)
      if (!isCapabilities(value)) failed('invalid-response')
      this.state = { ...this.state, capabilities: value }
    } else {
      const value = await this.request('/ping', 'GET', session.token)
      if (!hasKeys(value, ['protocol_version', 'status']) || value.status !== 'ok') failed('invalid-response')
    }
    this.state = { ...this.state, status: 'paired', checkedAt: this.now(), expiresAt: session.expiresAt, error: null, disconnectPending: false }
  }
  private async disconnect(session: StoredSession) {
    // Retain a session-only revocation credential until the server confirms.
    // It can only be used for DELETE, never ping, capabilities, or pairing.
    await this.save({ ...session, pendingRevocation: true })
    this.state = { ...initialConnection, disconnectPending: true }
    try {
      const value = await this.request('/session', 'DELETE', session.token)
      if (!hasKeys(value, ['protocol_version', 'status']) || value.status !== 'disconnected') failed('invalid-response')
    } catch (error) {
      if (!(error instanceof ServiceError) || error.code !== 'session-expired') failed('disconnect-unconfirmed')
    }
    await this.clear()
    this.state = { ...initialConnection }
  }
  async handle(request: ConnectionRequest): Promise<ConnectionResponse> {
    if (request.type === 'PIKO_SERVICE_DISCONNECT') { this.audioController?.abort(); this.interpretationController?.abort(); this.speechController?.abort() }
    if (this.busy) return { requestId: request.requestId, ok: false, state: { ...initialConnection, error: 'busy' } }
    this.busy = true
    try {
      try { await this.prepare() } catch { failed('storage-unavailable') }
      const session = await this.saved()
      if (session?.pendingRevocation) {
        await this.disconnect(session)
        return { requestId: request.requestId, ok: true, state: { ...this.state } }
      }
      switch (request.type) {
        case 'PIKO_SERVICE_DISCONNECT':
          if (session) await this.disconnect(session)
          else this.state = { ...initialConnection }
          break
        case 'PIKO_SERVICE_STATUS':
          if (session) await this.verify(session)
          else this.state = { ...initialConnection }
          break
        case 'PIKO_SERVICE_HEALTH': {
          const health = await this.request('/health')
          if (!hasKeys(health, ['status', 'service', 'version', 'inference', 'protocol_version']) || health.status !== 'ok' || health.service !== 'local-voice-form-assistant' || typeof health.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(health.version) || !['not_integrated', 'local_ollama'].includes(String(health.inference))) failed('invalid-response')
          this.state = { ...initialConnection, status: 'available', checkedAt: this.now() }
          if (session) await this.verify(session)
          break
        }
        case 'PIKO_SERVICE_PAIR': {
          // No automatic retries and no replacement pairing for an existing token.
          if (session) { await this.verify(session); break }
          const value = await this.request('/pair', 'POST', undefined, request.code)
          if (!hasKeys(value, ['protocol_version', 'token', 'expires_at']) || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token) || !Number.isSafeInteger(value.expires_at) || Number(value.expires_at) * 1000 <= this.now() || Number(value.expires_at) * 1000 > this.now() + SESSION_TTL_MS) failed('invalid-response')
          const paired: StoredSession = { token: value.token, origin: chrome.runtime.getURL('').replace(/\/$/, ''), expiresAt: Number(value.expires_at) * 1000, pendingRevocation: false }
          try { await this.save(paired) } catch {
            // Pairing already changed server state: revoke rather than retry it.
            try { await this.request('/session', 'DELETE', paired.token) } catch { /* Fixed error only; never log credentials. */ }
            failed('storage-unavailable')
          }
          await this.verify(paired)
          break
        }
        case 'PIKO_SERVICE_PING':
        case 'PIKO_SERVICE_CAPABILITIES':
          if (!session) failed('session-expired')
          await this.verify(session, request.type === 'PIKO_SERVICE_CAPABILITIES')
          break
      }
      return { requestId: request.requestId, ok: true, state: { ...this.state } }
    } catch (error) {
      const code = error instanceof ServiceError ? error.code : 'storage-unavailable'
      if (code === 'session-expired' || code === 'unsupported-origin') {
        try { await this.clear() } catch { /* Already fail closed. */ }
      }
      this.state = { ...initialConnection, status: code === 'session-expired' ? 'expired' : code === 'pairing-rejected' || code === 'rate-limited' || code === 'disconnect-unconfirmed' ? 'disconnected' : 'unavailable', error: code, disconnectPending: code === 'disconnect-unconfirmed' }
      return { requestId: request.requestId, ok: false, state: { ...this.state } }
    } finally { this.busy = false }
  }
}
import { isFormSummary, type FormSummary, type SummaryRequest } from '../features/assistant/form-summary'

import { voiceSession } from '../voice-output/voice-session'
import { initialRecording, type RecordingState } from './recording.types'
import { MAX_AUDIO_BYTES, MAX_RECORDING_MS, VoiceInputError, type Transcript } from './transcription.types'

interface RecorderDependencies {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  createRecorder: (stream: MediaStream, mimeType?: string) => MediaRecorder
  supports: (mime: string) => boolean
  now: () => number
  limitMs: number
  watchSilence?: (stream: MediaStream, stop: () => void) => () => void
}
const defaults: RecorderDependencies = {
  getUserMedia: constraints => {
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) return Promise.reject(new VoiceInputError('microphone-missing'))
    return navigator.mediaDevices.getUserMedia(constraints)
  },
  createRecorder: (stream, mimeType) => new MediaRecorder(stream, mimeType ? { mimeType } : undefined),
  supports: mime => Boolean(globalThis.MediaRecorder?.isTypeSupported(mime)),
  now: () => performance.now(), limitMs: MAX_RECORDING_MS,
}
export class RecordingController {
  private microphoneLease: symbol | null = null
  private state: RecordingState = { ...initialRecording }
  private recorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private chunks: Blob[] = []
  private size = 0
  private generation = 0
  private started = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private ticker: ReturnType<typeof setInterval> | undefined
  private abort: AbortController | null = null
  private silence: (() => void) | undefined
  private deps: RecorderDependencies
  constructor(private readonly update: (state: RecordingState) => void, private readonly transcribe: (audio: Blob, durationMs: number, signal: AbortSignal) => Promise<Transcript>, dependencies: Partial<RecorderDependencies> = {}) { this.deps = { ...defaults, ...dependencies } }
  get snapshot() { return { ...this.state } }
  get retainedBytes() { return this.size }
  private set(next: RecordingState) { this.state = next; this.update({ ...next }) }
  private stopTracks() {
    this.silence?.(); this.silence = undefined
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null
    if (this.microphoneLease) voiceSession.endRecording(this.microphoneLease)
    this.microphoneLease = null
  }
  private timers() { clearTimeout(this.timer); clearInterval(this.ticker) }
  reset(notify = true) {
    this.generation++; this.abort?.abort(); this.abort = null; this.timers()
    const recorder = this.recorder; this.recorder = null
    if (recorder) {
      recorder.ondataavailable = null; recorder.onstop = null; recorder.onerror = null
      try { if (recorder.state !== 'inactive') recorder.stop() } catch { /* Tracks still need releasing after a recorder failure. */ }
    }
    this.stopTracks(); this.chunks = []; this.size = 0
    if (notify) this.set({ ...initialRecording })
  }
  private fail(error: VoiceInputError['code']) {
    this.reset(false)
    this.set({ ...initialRecording, stage: 'error', error })
  }
  async start() {
    if (['recording', 'requesting-permission', 'processing'].includes(this.state.stage)) return
    this.reset(false)
    const version = this.generation
    this.microphoneLease = voiceSession.beginRecording(() => this.reset())
    this.set({ ...initialRecording, stage: 'requesting-permission' })
    try {
      const stream = await this.deps.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
      if (version !== this.generation) { stream.getTracks().forEach(track => track.stop()); return }
      this.stream = stream
      stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => { if (version === this.generation && this.state.stage === 'recording') this.fail('recording-failed') }))
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(this.deps.supports)
      const recorder = this.deps.createRecorder(stream, mime)
      this.recorder = recorder
      recorder.ondataavailable = event => {
        if (version !== this.generation || !event.data.size) return
        this.size += event.data.size
        if (this.size > MAX_AUDIO_BYTES) { this.fail('audio-too-large'); return }
        this.chunks.push(event.data)
      }
      recorder.onerror = () => { if (version === this.generation) this.fail('recording-failed') }
      recorder.onstop = () => { if (version === this.generation) void this.finish(version, recorder.mimeType) }
      this.started = this.deps.now()
      recorder.start(250)
      this.silence = this.deps.watchSilence?.(stream, () => this.stop())
      this.set({ ...initialRecording, stage: 'recording' })
      this.ticker = setInterval(() => { if (this.state.stage === 'recording') this.set({ ...this.state, elapsedMs: Math.min(this.deps.limitMs, this.deps.now() - this.started) }) }, 250)
      this.timer = setTimeout(() => this.stop(), this.deps.limitMs)
    } catch (error) {
      if (version !== this.generation) return
      const name = error instanceof Error ? error.name : ''
      this.fail(error instanceof VoiceInputError ? error.code : name === 'NotAllowedError' || name === 'SecurityError' ? 'microphone-denied' : name === 'NotFoundError' || name === 'DevicesNotFoundError' ? 'microphone-missing' : 'recording-failed')
    }
  }
  stop() {
    if (this.state.stage !== 'recording') return
    this.timers()
    this.set({ ...this.state, stage: 'processing', elapsedMs: Math.min(this.deps.limitMs, this.deps.now() - this.started) })
    try { if (this.recorder?.state !== 'inactive') this.recorder?.stop() } catch { this.fail('recording-failed') }
    finally { this.stopTracks() }
  }
  private async finish(version: number, mimeType: string) {
    this.timers(); this.stopTracks(); this.recorder = null
    const duration = Math.round(this.state.elapsedMs || this.deps.now() - this.started)
    const audio = new Blob(this.chunks, { type: mimeType })
    this.chunks = []; this.size = 0
    if (!audio.size || duration < 250) { this.fail('empty-audio'); return }
    this.set({ ...initialRecording, stage: 'processing', elapsedMs: duration })
    this.abort = new AbortController()
    try {
      const result = await this.transcribe(audio, duration, this.abort.signal)
      if (version !== this.generation) return
      this.set({ ...initialRecording, stage: result.status === 'ok' ? 'transcript-ready' : 'no-speech', transcript: result.text })
    } catch (error) {
      if (version === this.generation) this.fail(error instanceof VoiceInputError ? error.code : 'transcription-failed')
    } finally { if (version === this.generation) this.abort = null }
  }
}

/** End a spoken turn after speech followed by quiet. The existing 20s hard cap
 * still applies. No audio leaves this in-memory analyser. */
export function watchSilence(stream: MediaStream, stop: () => void): () => void {
  const context = new AudioContext(), source = context.createMediaStreamSource(stream), analyser = context.createAnalyser()
  analyser.fftSize = 2048; source.connect(analyser)
  const samples = new Float32Array(analyser.fftSize)
  let heard = false, lastVoice = performance.now()
  void context.resume().catch(() => {})
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples)
    const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)
    if (rms > 0.006) { heard = true; lastVoice = performance.now() }
    else if (heard && performance.now() - lastVoice > 2500) stop()
  }, 100)
  return () => { clearInterval(timer); source.disconnect(); analyser.disconnect(); void context.close().catch(() => {}) }
}

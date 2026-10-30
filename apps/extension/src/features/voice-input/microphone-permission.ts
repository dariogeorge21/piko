import { isRecord, makeId } from '../scanner/scanner.messages'

/** Chrome can suppress permission prompts inside a side panel. Use a visible
 * extension tab once, then stop its tracks and return to the original website. */
export async function ensureMicrophonePermission(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('request-cancelled')
  try { if ((await navigator.permissions.query({ name: 'microphone' as PermissionName })).state === 'granted') return } catch { /* Older Chromium: use the dedicated page. */ }
  const requestId = makeId('request'), path = chrome.runtime.getURL('microphone.html')
  const [target] = await chrome.tabs.query({ active: true, currentWindow: true })
  await new Promise<void>((resolve, reject) => {
    let helperId: number | undefined
    let settled = false
    const finish = async (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer); chrome.runtime.onMessage.removeListener(receive); chrome.tabs.onRemoved.removeListener(removed)
      signal?.removeEventListener('abort', aborted)
      if (helperId !== undefined) await chrome.tabs.remove(helperId).catch(() => {})
      if (target?.id !== undefined) await chrome.tabs.update(target.id, { active: true }).catch(() => {})
      if (ok) resolve(); else reject(new Error('microphone-denied'))
    }
    const receive = (message: unknown, sender: chrome.runtime.MessageSender) => {
      if (sender.id !== chrome.runtime.id || sender.tab?.id !== helperId || sender.url !== `${path}?requestId=${requestId}` || !isRecord(message) || message.type !== 'PIKO_MIC_PERMISSION_RESULT' || message.requestId !== requestId) return
      void finish(message.ok === true)
    }
    const removed = (id: number) => { if (id === helperId) void finish(false) }
    const aborted = () => { void finish(false) }
    const timer = setTimeout(() => { void finish(false) }, 120000)
    chrome.runtime.onMessage.addListener(receive); chrome.tabs.onRemoved.addListener(removed)
    signal?.addEventListener('abort', aborted, { once: true })
    if (signal?.aborted) { aborted(); return }
    void chrome.tabs.create({ url: `${path}?requestId=${requestId}` }).then(tab => { if (settled && tab.id !== undefined) void chrome.tabs.remove(tab.id).catch(() => {}); else helperId = tab.id }, () => { void finish(false) })
  })
}

const requestId = new URL(location.href).searchParams.get('requestId')
const button = document.getElementById('allow'), status = document.getElementById('status')
button.disabled = !/^request_[a-f0-9]{32}$/.test(requestId ?? '')
button.addEventListener('click', async () => {
  button.disabled = true
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    stream.getTracks().forEach(track => track.stop())
    status.textContent = 'Microphone enabled. Returning to your form…'
    await chrome.runtime.sendMessage({ type: 'PIKO_MIC_PERMISSION_RESULT', requestId, ok: true })
  } catch {
    status.textContent = 'Microphone access was blocked. Allow it in Chrome’s site controls and try again.'
    button.disabled = false
  }
})

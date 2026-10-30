import { useEffect, useState, useSyncExternalStore } from 'react'
import { GuidedAssistant } from './guided-assistant'
import { isActivated, isInvalidated, isRecord } from '../scanner/scanner.messages'
import { connectionAction } from '../local-service/connection.service'
import { publishConnection } from '../local-service/connection.store'

export function useGuidedAssistant() {
  const [controller] = useState(() => new GuidedAssistant(undefined, { connect: async () => {
    const reply = await connectionAction({ type: 'PIKO_SERVICE_PAIR' }); publishConnection(reply.state)
    if (!reply.ok || reply.state.status !== 'paired') throw Error('connection')
    return { transcription: reply.state.capabilities?.transcription === 'ready', speech: reply.state.capabilities?.speech_synthesis === 'ready' }
  } }))
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot)
  useEffect(() => {
    controller.attach()
    const listener = (message: unknown, sender: chrome.runtime.MessageSender) => {
      if (sender.id !== chrome.runtime.id || sender.tab) return
      const current = controller.workflow.snapshot()
      if (isActivated(message) && current.scan && current.scan.tabId !== message.tabId) controller.stale('tab-switched')
      if (isInvalidated(message) && current.scan?.tabId === message.tabId && (message.scanId === null || message.scanId === current.scan.inventory.scanId)) controller.stale(message.reason)
      if (isRecord(message) && message.type === 'PIKO_SESSION_CLEARED' && (message.sessionId === null || message.sessionId === current.session?.sessionId)) void controller.workflow.refreshSession()
    }
    chrome.runtime.onMessage.addListener(listener)
    const hide = () => controller.dispose()
    window.addEventListener('pagehide', hide)
    return () => { chrome.runtime.onMessage.removeListener(listener); window.removeEventListener('pagehide', hide); controller.dispose() }
  }, [controller])
  useEffect(() => {
    if (!state.workflow.session) return
    const timer = setTimeout(() => void controller.workflow.refreshSession(), Math.max(0, state.workflow.session.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [controller, state.workflow.session])
  return { state, controller }
}

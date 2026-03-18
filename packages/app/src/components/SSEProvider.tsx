/**
 * SSEProvider — manages the OpenCode SSE connection at the app level.
 *
 * This component MUST live outside the spotlight/main mode conditional in App.tsx
 * so the SSE connection persists across mode switches. Previously, SSE was inside
 * ChatPanel which gets unmounted in spotlight mode, breaking streaming.
 */
import { useEffect, useRef } from 'react'
import { useSessionStore } from '@/stores/session'
import { useWorkspaceStore } from '@/stores/workspace'
import { useOpenCodeSSE } from '@/lib/opencode/sse'

export function SSEProvider() {
  const activeSessionId = useSessionStore(s => s.activeSessionId)
  const workspacePath = useWorkspaceStore(s => s.workspacePath)
  const openCodeUrl = useWorkspaceStore(s => s.openCodeUrl)

  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Actions via getState() — stable refs, no subscriptions
  const acts = useSessionStore.getState()

  useOpenCodeSSE(openCodeUrl ?? "", activeSessionId, {
    onMessageCreated: acts.handleMessageCreated,
    onMessagePartCreated: acts.handleMessagePartCreated,
    onMessagePartUpdated: acts.handleMessagePartUpdated,
    onMessageCompleted: acts.handleMessageCompleted,
    onToolExecuting: acts.handleToolExecuting,
    onPermissionAsked: acts.handlePermissionAsked,
    onQuestionAsked: acts.handleQuestionAsked,
    onTodoUpdated: acts.handleTodoUpdated,
    onSessionDiff: acts.handleSessionDiff,
    onFileEdited: (e) => acts.handleFileEdited(e.file),
    onSessionError: acts.handleSessionError,
    onSessionCreated: acts.handleSessionCreated,
    onSessionUpdated: acts.handleSessionUpdated,
    onExternalMessage: acts.handleExternalMessage,
    onSessionStatus: acts.handleSessionStatus,
    onSessionBusy: acts.handleSessionBusy,
    onSessionIdle: acts.handleSessionIdle,
    onChildSessionEvent: acts.handleChildSessionEvent,
    onConnected: () => {
      if (disconnectTimerRef.current) {
        clearTimeout(disconnectTimerRef.current)
        disconnectTimerRef.current = null
      }
      acts.setConnected(true)
    },
    onDisconnected: () => {
      if (!disconnectTimerRef.current) {
        disconnectTimerRef.current = setTimeout(() => {
          acts.setConnected(false)
          disconnectTimerRef.current = null
        }, 3000)
      }
    },
    onError: (e) => acts.setError(e.message),
    onInactivityWarning: (active) => acts.setInactivityWarning(active),
  }, workspacePath)

  // Clean up disconnect debounce timer on unmount
  useEffect(() => {
    return () => {
      if (disconnectTimerRef.current) {
        clearTimeout(disconnectTimerRef.current)
      }
    }
  }, [])

  return null
}

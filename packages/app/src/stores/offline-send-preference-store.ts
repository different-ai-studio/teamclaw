import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface State {
  /** sessionId → user dismissed offline send confirm */
  dismissedBySession: Record<string, boolean>
  dismissForSession: (sessionId: string) => void
  isDismissed: (sessionId: string) => boolean
}

export const useOfflineSendPreferenceStore = create<State>()(
  persist(
    (set, get) => ({
      dismissedBySession: {},
      dismissForSession: (sessionId) =>
        set((s) => ({
          dismissedBySession: { ...s.dismissedBySession, [sessionId]: true },
        })),
      isDismissed: (sessionId) => !!get().dismissedBySession[sessionId],
    }),
    { name: 'teamclaw-offline-send-pref' },
  ),
)

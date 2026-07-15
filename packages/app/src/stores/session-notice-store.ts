import { create } from 'zustand'

export type SessionNotice = {
  id: string
  sessionId: string
  text: string
  createdAt: number
}

const EMPTY_NOTICES: SessionNotice[] = []

interface State {
  bySession: Record<string, SessionNotice[]>
  append: (sessionId: string, text: string) => string
  clearSession: (sessionId: string) => void
  getForSession: (sessionId: string) => SessionNotice[]
}

export const useSessionNoticeStore = create<State>((set, get) => ({
  bySession: {},
  append: (sessionId, text) => {
    const id = crypto.randomUUID()
    const notice: SessionNotice = {
      id,
      sessionId,
      text,
      createdAt: Date.now(),
    }
    set((s) => ({
      bySession: {
        ...s.bySession,
        [sessionId]: [...(s.bySession[sessionId] ?? []), notice],
      },
    }))
    return id
  },
  clearSession: (sessionId) =>
    set((s) => {
      const next = { ...s.bySession }
      delete next[sessionId]
      return { bySession: next }
    }),
  getForSession: (sessionId) => get().bySession[sessionId] ?? EMPTY_NOTICES,
}))

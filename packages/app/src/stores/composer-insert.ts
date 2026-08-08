import { create } from 'zustand'

/**
 * A one-slot channel for dropping text into the chat composer from elsewhere
 * in the UI — the file tree and the diff panel use it to insert `@{path}`
 * mentions. `ChatInputArea` registers the handler while it is mounted.
 *
 * This used to live in `stores/voice-input.ts` alongside the voice capture
 * state, which is why the name mentioned voice at all. When voice input was
 * removed this was the only part still in use, so it moved here under a name
 * that says what it does.
 */
interface ComposerInsertState {
  _handler: ((text: string) => void) | null
  /** Returns an unregister function; call it on unmount. */
  registerInsertToChatHandler: (handler: (text: string) => void) => () => void
  /** No-op when nothing is registered — the composer may not be mounted. */
  insertToChat: (text: string) => void
}

export const useComposerInsertStore = create<ComposerInsertState>((set, get) => ({
  _handler: null,
  registerInsertToChatHandler: (handler) => {
    set({ _handler: handler })
    return () => set({ _handler: null })
  },
  insertToChat: (text) => {
    const handler = get()._handler
    if (handler) handler(text)
  },
}))

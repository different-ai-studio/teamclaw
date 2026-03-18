import { useSessionStore } from './session'
import { useStreamingStore } from './streaming'

if (import.meta.env.DEV) {
  ;(window as any).__TEAMCLAW_STORES__ = {
    session: useSessionStore,
    streaming: useStreamingStore,
  }
}

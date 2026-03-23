import { useSessionStore } from './session'
import { useStreamingStore } from './streaming'

if (import.meta.env.DEV) {
  ;(window as any).__TEAMCLAW_STORES__ = {
    session: useSessionStore,
    streaming: useStreamingStore,
  }

  // Set up execute-js event listener for tauri-plugin-mcp socket automation.
  // The Rust plugin emits 'execute-js' with the JS code as payload,
  // and expects 'execute-js-response' back with { result, type } or { error }.
  Promise.all([
    import('@tauri-apps/api/event'),
    import('@tauri-apps/api/webviewWindow'),
  ]).then(([{ emit }, { getCurrentWebviewWindow }]) => {
    const currentWindow = getCurrentWebviewWindow()
    currentWindow.listen('execute-js', async (event: any) => {
      // payload may be the code string directly or { code: string }
      const code = typeof event.payload === 'string'
        ? event.payload
        : event.payload?.code
      try {
        const result = (0, eval)(code)
        // Use global emit so app-level listener in Rust receives it
        await emit('execute-js-response', {
          result: typeof result === 'object' ? JSON.stringify(result) : String(result),
          type: typeof result,
        })
      } catch (error) {
        await emit('execute-js-response', {
          error: String(error),
        })
      }
    })
    console.log('[dev-expose] execute-js listener installed')
  }).catch(() => {})
}

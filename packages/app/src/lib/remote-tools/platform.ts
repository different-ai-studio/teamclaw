import { capabilities } from '@/lib/platform'

import { registerExecutor } from './registry'
import { TOOL_GET_PAGE_DOM } from './types'
import { createBrowserGetPageDomExecutor } from './executors/browser-get-page-dom'

let registered = false

export function registerPlatformExecutors(): void {
  if (registered) return
  registered = true

  if (capabilities.pageCapture) {
    registerExecutor(TOOL_GET_PAGE_DOM, createBrowserGetPageDomExecutor())
  }
}

/** Test helper — reset registration gate. */
export function resetPlatformExecutorsForTests(): void {
  registered = false
}

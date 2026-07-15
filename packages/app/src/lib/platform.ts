import { isTauri } from './utils'

export type AppPlatform = 'desktop' | 'extension' | 'web'

type ChromeRuntimeLike = { id?: string }

function readChromeRuntime(): ChromeRuntimeLike | undefined {
  if (typeof globalThis === 'undefined') return undefined
  const chrome = (globalThis as { chrome?: { runtime?: ChromeRuntimeLike } }).chrome
  return chrome?.runtime
}

/** Running inside a Chrome MV3 extension (side panel / content script context). */
export function isChromeExtension(): boolean {
  return Boolean(readChromeRuntime()?.id)
}

export function getAppPlatform(): AppPlatform {
  if (isTauri()) return 'desktop'
  if (isChromeExtension()) return 'extension'
  return 'web'
}

/** Runtime capability flags — prefer these over scattered isTauri() checks. */
export const capabilities = {
  get workspace() {
    return getAppPlatform() === 'desktop'
  },
  get tauriInvoke() {
    return isTauri()
  },
  get pageCapture() {
    return getAppPlatform() === 'extension'
  },
} as const

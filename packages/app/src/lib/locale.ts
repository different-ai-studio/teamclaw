import { appShortName } from '@/lib/build-config'

export const LANGUAGE_STORAGE_KEY = `${appShortName}-language`

function getStorage(): Storage | undefined {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage
  }

  if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
    return globalThis.localStorage
  }

  return undefined
}

function getNavigator(): Navigator | undefined {
  if (typeof window !== 'undefined' && window.navigator) {
    return window.navigator
  }

  if (typeof globalThis !== 'undefined' && 'navigator' in globalThis) {
    return globalThis.navigator
  }

  return undefined
}

export function normalizeSupportedLanguage(language: string | null | undefined): string {
  if (!language) return 'en'

  const normalized = language.toLowerCase()
  if (normalized === 'en' || normalized.startsWith('en-')) {
    return 'en'
  }
  if (normalized === 'zh' || normalized.startsWith('zh-')) {
    return 'zh-CN'
  }

  return 'en'
}

export function getStoredLanguage(): string | null {
  const storage = getStorage()
  if (!storage) return null

  try {
    const language = storage.getItem(LANGUAGE_STORAGE_KEY)
    return language ? normalizeSupportedLanguage(language) : null
  } catch {
    return null
  }
}

export function getSystemLanguage(): string {
  const nav = getNavigator()
  if (!nav) return 'en'

  const candidates = nav.languages?.length ? nav.languages : [nav.language]
  for (const candidate of candidates) {
    const language = normalizeSupportedLanguage(candidate)
    if (language !== 'en' || candidate?.toLowerCase().startsWith('en')) {
      return language
    }
  }

  return 'en'
}

export function getPreferredLanguage(): string {
  return getStoredLanguage() ?? getSystemLanguage()
}

export function persistLanguage(language: string): void {
  const storage = getStorage()
  if (!storage) return

  try {
    storage.setItem(LANGUAGE_STORAGE_KEY, normalizeSupportedLanguage(language))
  } catch {
    // Ignore storage failures and continue with in-memory language state.
  }
}

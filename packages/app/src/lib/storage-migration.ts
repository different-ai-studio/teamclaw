import { appStoragePrefix, isOfficialBrand, appShortName } from '@/lib/build-config'

const MIGRATION_MARKER = 'teamclaw-localstorage-namespace-v1'

const LEGACY_OFFICIAL_PREFIXES = ['teamclawdev']

/**
 * One-shot migration: `teamclawdev-*` localStorage keys → `teamclaw-*` for
 * official builds (Decision 1 = B). Idempotent.
 */
export function migrateOfficialLocalStorage(): void {
  if (typeof localStorage === 'undefined') return
  if (!isOfficialBrand(appShortName)) return
  if (localStorage.getItem(MIGRATION_MARKER) === '1') return

  for (const legacyPrefix of LEGACY_OFFICIAL_PREFIXES) {
    if (legacyPrefix === appStoragePrefix) continue
    const keysToMove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(`${legacyPrefix}-`)) {
        keysToMove.push(key)
      }
    }
    for (const oldKey of keysToMove) {
      const newKey = `${appStoragePrefix}-${oldKey.slice(legacyPrefix.length + 1)}`
      if (localStorage.getItem(newKey) == null) {
        const value = localStorage.getItem(oldKey)
        if (value != null) {
          localStorage.setItem(newKey, value)
        }
      }
      localStorage.removeItem(oldKey)
    }
  }

  localStorage.setItem(MIGRATION_MARKER, '1')
}

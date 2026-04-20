/**
 * Pre-sync warning thresholds for team git mode.
 * Trigger the warning dialog if ANY of these is exceeded among untracked files.
 */
export const MAX_NEW_FILE_COUNT = 50
export const MAX_SINGLE_FILE_BYTES = 10 * 1024 * 1024 // 10 MB
export const MAX_TOTAL_NEW_BYTES = 100 * 1024 * 1024 // 100 MB

export interface SyncPrecheckFile {
  path: string
  sizeBytes: number
}

export interface SyncPrecheckResult {
  newFiles: SyncPrecheckFile[]
  totalBytes: number
}

/**
 * Returns true if the precheck result breaches any threshold and the user
 * should see a confirmation dialog before sync proceeds.
 */
export function shouldShowPrecheckWarning(result: SyncPrecheckResult): boolean {
  if (result.newFiles.length > MAX_NEW_FILE_COUNT) return true
  if (result.totalBytes > MAX_TOTAL_NEW_BYTES) return true
  return result.newFiles.some((f) => f.sizeBytes > MAX_SINGLE_FILE_BYTES)
}

/**
 * Human-readable byte size, e.g. 10485760 → "10.0 MB".
 * Fixed units so output is stable across locales.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

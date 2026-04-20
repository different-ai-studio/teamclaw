/**
 * Types mirroring the backend `SyncPrecheckFile` and the precheck fields on
 * `TeamGitResult`. The threshold check itself lives in Rust (see
 * `team_sync_repo` in src-tauri/src/commands/team.rs) so all sync entry points
 * are gated at the source.
 */
export interface SyncPrecheckFile {
  path: string
  sizeBytes: number
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

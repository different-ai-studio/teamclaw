import {
  captureTelemetry,
  shouldReportThrottled,
  truncateForExtra,
} from '@/lib/telemetry/capture'

/**
 * Sentry reporting for the libsql local-cache layer.
 *
 * The cache is a best-effort accelerator: every read/write here is allowed to
 * fail without blocking the cloud-backed render path. That makes silent
 * swallowing tempting and wrong — a persistent `team gate mismatch` is a real
 * defect that has to stay visible. Report it, then carry on.
 */

export type LocalCacheFailureKind =
  /** Current-team gate rejected the row/team the caller asked for. */
  | 'team_gate_mismatch'
  /** The caller passed an empty team id — a bug in the caller, not the gate. */
  | 'empty_team_id'
  /** Anything else (db open failure, serialization, ...). */
  | 'unknown'

const THROTTLE_WINDOW_MS = 60_000

export function classifyLocalCacheFailure(reason: string | undefined): LocalCacheFailureKind {
  const lower = (reason ?? '').trim().toLowerCase()
  if (!lower) return 'unknown'
  if (lower.includes('team gate mismatch')) {
    // `requested=` / `row_team=` with nothing after it means the caller handed
    // the command an empty team id; that is a different bug from a real gate
    // mismatch and must not share a fingerprint with it.
    return /(requested|row_team|session_team|idea_team)=\s*\)/.test(lower)
      ? 'empty_team_id'
      : 'team_gate_mismatch'
  }
  return 'unknown'
}

/**
 * Report a local-cache failure. Throttled per (command, kind) so a team that
 * stays mismatched cannot produce hundreds of identical events — the previous
 * unhandled-rejection path did exactly that.
 */
export function reportLocalCacheFailure(
  command: string,
  error: unknown,
  context: { teamId?: string | null; sessionId?: string | null } = {},
): void {
  const reason = error instanceof Error ? error.message : String(error)
  const kind = classifyLocalCacheFailure(reason)
  if (!shouldReportThrottled(`local_cache|${command}|${kind}`, THROTTLE_WINDOW_MS)) return

  captureTelemetry({
    message: `local_cache_failed: ${command} (${kind})`,
    // The cache failing degrades performance, not correctness — the caller is
    // required to carry on without it. Warning, not error.
    level: 'warning',
    fingerprint: ['local_cache', command, kind],
    tags: { local_cache_command: command, local_cache_failure_kind: kind },
    extra: {
      reason: truncateForExtra(reason),
      teamId: context.teamId ?? null,
      sessionId: context.sessionId ?? null,
    },
  })
}

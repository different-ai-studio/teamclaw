import type { RuntimeStartFailure, RuntimeStartFailureCode } from '@/lib/session-create'

/**
 * Sentry reporting for the agent-runtime startup path.
 *
 * These failures only ever surfaced as toasts, so their real-world frequency
 * was invisible — Sentry held zero events for `rpc timeout` or `runtimeStart`
 * even though the toasts fire regularly.
 *
 * Grouping rule: never interpolate ids, durations, or raw reasons into the
 * captured message. Sentry fingerprints on message text, and embedded UUIDs
 * shatter one problem into dozens of issues (see the `team gate mismatch`
 * issues, which fragmented exactly that way). Ids go in tags/extra; the
 * fingerprint is (kind, code, reasonKind).
 */

export type RuntimeErrorKind =
  /** A per-agent failure from the runtimeStart fanout or its gates. */
  | 'runtime_start_failure'
  /** MQTT/RPC never became ready, so runtimeStart was never attempted. */
  | 'rpc_not_ready'
  /** The ensure-runtime batch itself threw. */
  | 'ensure_runtime_crash'

/**
 * Sub-classification of a failure `reason`. `RuntimeStartFailureCode` alone
 * cannot distinguish "the daemon took too long" from "we never managed to
 * publish" — both arrive as `runtime_rpc_failed`.
 */
export type RuntimeFailureReasonKind =
  | 'rpc_timeout'
  | 'local_rpc_timeout'
  | 'rpc_not_initialized'
  | 'mqtt_publish_failed'
  | 'mqtt_disconnected'
  | 'device_offline'
  | 'daemon_rejected'
  | 'unknown'

export type RuntimeErrorContext = {
  sessionId?: string
  teamId?: string
  agentActorId?: string
  /** Why ensure-runtime ran (send, wake, reconnect, ...). */
  trigger?: string
}

const THROTTLE_WINDOW_MS = 60_000
const MAX_REASON_LENGTH = 300

const lastReportedAt = new Map<string, number>()

/** @internal test hook */
export function __resetRuntimeErrorReportThrottleForTest(): void {
  lastReportedAt.clear()
}

export function classifyRuntimeFailureReason(reason: string | undefined): RuntimeFailureReasonKind {
  const lower = (reason ?? '').trim().toLowerCase()
  if (!lower) return 'unknown'
  if (lower.includes('local rpc timeout')) return 'local_rpc_timeout'
  if (lower.includes('rpc timeout')) return 'rpc_timeout'
  if (lower.includes('not initialized') || lower.includes('actorid required')) {
    return 'rpc_not_initialized'
  }
  if (lower.includes('mqtt disconnected') || lower.includes('mqtt not connected')) {
    return 'mqtt_disconnected'
  }
  if (lower.includes('device offline')) return 'device_offline'
  if (lower.includes('publish')) return 'mqtt_publish_failed'
  if (lower.includes('rejected')) return 'daemon_rejected'
  return 'unknown'
}

/** Offline transports are expected states, not defects — keep them off the error feed. */
function levelForCode(code: RuntimeStartFailureCode | undefined): 'warning' | 'error' {
  return code === 'device_offline' || code === 'transport_offline' ? 'warning' : 'error'
}

function shouldReport(key: string, now: number): boolean {
  const previous = lastReportedAt.get(key)
  if (previous !== undefined && now - previous < THROTTLE_WINDOW_MS) return false
  lastReportedAt.set(key, now)
  return true
}

function truncateReason(reason: string | undefined): string {
  const trimmed = (reason ?? '').trim()
  return trimmed.length > MAX_REASON_LENGTH ? `${trimmed.slice(0, MAX_REASON_LENGTH)}…` : trimmed
}

/**
 * One shared import for every capture. Kept lazy so the runtime path does not
 * pull Sentry in eagerly, and memoized so a burst of failures in the same tick
 * resolves against a single module promise.
 */
let sentryModule: Promise<typeof import('@sentry/react')> | null = null

function loadSentry(): Promise<typeof import('@sentry/react')> {
  sentryModule ??= import('@sentry/react')
  return sentryModule
}

/** @internal test hook */
export function __resetSentryModuleForTest(): void {
  sentryModule = null
}

type CaptureArgs = {
  kind: RuntimeErrorKind
  code?: RuntimeStartFailureCode
  reason?: string
  error?: unknown
  context: RuntimeErrorContext
}

function capture({ kind, code, reason, error, context }: CaptureArgs): void {
  const reasonKind = classifyRuntimeFailureReason(reason)
  const fingerprint = ['runtime', kind, code ?? 'none', reasonKind]
  const tags: Record<string, string> = {
    runtime_error_kind: kind,
    runtime_failure_code: code ?? 'none',
    runtime_failure_reason_kind: reasonKind,
  }
  const extra: Record<string, unknown> = {
    reason: truncateReason(reason),
    sessionId: context.sessionId ?? null,
    teamId: context.teamId ?? null,
    agentActorId: context.agentActorId ?? null,
    trigger: context.trigger ?? null,
  }
  const level = levelForCode(code)

  void loadSentry()
    .then((Sentry) => {
      if (error !== undefined) {
        Sentry.captureException(error, { level, tags, extra, fingerprint })
        return
      }
      Sentry.captureMessage(`${kind}: ${code ?? reasonKind}`, {
        level,
        tags,
        extra,
        fingerprint,
      })
    })
    .catch(() => {
      // Telemetry must never break the runtime path.
    })
}

/**
 * Report one per-agent runtimeStart failure. Throttled per
 * (kind, code, agent) so the wake/focus/reconnect ensure loop cannot flood
 * Sentry with the same offline daemon.
 */
export function reportRuntimeStartFailure(
  failure: RuntimeStartFailure,
  context: RuntimeErrorContext = {},
): void {
  const key = `runtime_start_failure|${failure.code}|${failure.agentActorId}`
  if (!shouldReport(key, Date.now())) return
  capture({
    kind: 'runtime_start_failure',
    code: failure.code,
    reason: failure.reason,
    context: { ...context, agentActorId: failure.agentActorId },
  })
}

export function reportRuntimeRpcNotReady(
  waitedMs: number,
  context: RuntimeErrorContext = {},
): void {
  const key = `rpc_not_ready|${context.sessionId ?? ''}`
  if (!shouldReport(key, Date.now())) return
  capture({
    kind: 'rpc_not_ready',
    reason: `teamclaw rpc not ready after ${waitedMs}ms`,
    context,
  })
}

export function reportRuntimeEnsureCrash(
  error: unknown,
  context: RuntimeErrorContext = {},
): void {
  const reason = error instanceof Error ? error.message : String(error)
  const key = [
    'ensure_runtime_crash',
    classifyRuntimeFailureReason(reason),
    context.trigger ?? '',
    context.sessionId ?? '',
  ].join('|')
  if (!shouldReport(key, Date.now())) return
  capture({ kind: 'ensure_runtime_crash', reason, error, context })
}

import type { RuntimeStartFailure, RuntimeStartFailureCode } from '@/lib/session-create'
import {
  captureTelemetry,
  shouldReportThrottled,
  truncateForExtra,
  type TelemetryLevel,
} from '@/lib/telemetry/capture'

export {
  __resetSentryModuleForTest,
  __resetTelemetryThrottleForTest as __resetRuntimeErrorReportThrottleForTest,
} from '@/lib/telemetry/capture'

/**
 * Sentry reporting for the agent-runtime startup path.
 *
 * These failures only ever surfaced as toasts, so their real-world frequency
 * was invisible — Sentry held zero events for `rpc timeout` or `runtimeStart`
 * even though the toasts fire regularly. See `capture.ts` for the grouping
 * rule every reporter here follows.
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
function levelForCode(code: RuntimeStartFailureCode | undefined): TelemetryLevel {
  return code === 'device_offline' || code === 'transport_offline' ? 'warning' : 'error'
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
  captureTelemetry({
    message: `${kind}: ${code ?? reasonKind}`,
    level: levelForCode(code),
    fingerprint: ['runtime', kind, code ?? 'none', reasonKind],
    tags: {
      runtime_error_kind: kind,
      runtime_failure_code: code ?? 'none',
      runtime_failure_reason_kind: reasonKind,
    },
    extra: {
      reason: truncateForExtra(reason),
      sessionId: context.sessionId ?? null,
      teamId: context.teamId ?? null,
      agentActorId: context.agentActorId ?? null,
      trigger: context.trigger ?? null,
    },
    error,
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
  if (!shouldReportThrottled(key, THROTTLE_WINDOW_MS)) return
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
  if (!shouldReportThrottled(key, THROTTLE_WINDOW_MS)) return
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
  if (!shouldReportThrottled(key, THROTTLE_WINDOW_MS)) return
  capture({ kind: 'ensure_runtime_crash', reason, error, context })
}

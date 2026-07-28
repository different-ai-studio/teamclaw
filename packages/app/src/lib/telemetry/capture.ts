/**
 * Shared Sentry plumbing for the telemetry reporters in this directory.
 *
 * Grouping rule every reporter must follow: never interpolate ids, durations,
 * or raw reasons into `message`. Sentry fingerprints on message text, and
 * embedded UUIDs shatter one problem into dozens of issues — the
 * `team gate mismatch` reports fragmented into four separate issues exactly
 * that way. Ids belong in tags/extra with an explicit `fingerprint`.
 */

export type TelemetryLevel = 'warning' | 'error'

export type TelemetryCaptureArgs = {
  /** Stable across occurrences — no ids, no numbers. */
  message: string
  level: TelemetryLevel
  tags: Record<string, string>
  extra: Record<string, unknown>
  fingerprint: string[]
  /** When present, captured as an exception instead of a message. */
  error?: unknown
}

/**
 * One shared import for every capture. Kept lazy so hot paths do not pull
 * Sentry in eagerly, and memoized so a burst of reports in the same tick
 * resolves against a single module promise (concurrent dynamic imports of the
 * same module do not reliably settle).
 */
let sentryModule: Promise<typeof import('@sentry/react')> | null = null

export function loadSentry(): Promise<typeof import('@sentry/react')> {
  sentryModule ??= import('@sentry/react')
  return sentryModule
}

/** @internal test hook */
export function __resetSentryModuleForTest(): void {
  sentryModule = null
}

const lastReportedAt = new Map<string, number>()

/**
 * True when `key` has not been reported inside `windowMs`. Reporters that sit
 * on retry/wake loops must throttle, or one persistent fault produces hundreds
 * of identical events.
 */
export function shouldReportThrottled(key: string, windowMs: number): boolean {
  const now = Date.now()
  const previous = lastReportedAt.get(key)
  if (previous !== undefined && now - previous < windowMs) return false
  lastReportedAt.set(key, now)
  return true
}

/** @internal test hook */
export function __resetTelemetryThrottleForTest(): void {
  lastReportedAt.clear()
}

export function truncateForExtra(value: string | undefined, maxLength = 300): string {
  const trimmed = (value ?? '').trim()
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed
}

export function captureTelemetry({
  message,
  level,
  tags,
  extra,
  fingerprint,
  error,
}: TelemetryCaptureArgs): void {
  void loadSentry()
    .then((Sentry) => {
      if (error !== undefined) {
        Sentry.captureException(error, { level, tags, extra, fingerprint })
        return
      }
      Sentry.captureMessage(message, { level, tags, extra, fingerprint })
    })
    .catch(() => {
      // Telemetry must never break the path it observes.
    })
}

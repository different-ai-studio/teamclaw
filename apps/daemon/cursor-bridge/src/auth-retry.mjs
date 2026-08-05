/**
 * Detect stale Cursor SDK auth failures (expired gRPC token / idle connection).
 * These are retryable with Agent.resume() + resend — not a bad API key.
 */

export function errorMessage(err) {
  if (err == null) return ''
  if (typeof err === 'string') return err
  if (typeof err.message === 'string' && err.message) return err.message
  return String(err)
}

export function isStaleAuthErrorMessage(message) {
  const lower = String(message ?? '').toLowerCase()
  if (!lower) return false
  return (
    lower.includes('authentication') ||
    lower.includes('not logged in') ||
    lower.includes('unauthenticated') ||
    lower.includes('error_not_logged_in')
  )
}

export function isStaleAuthError(err) {
  if (err == null) return false
  if (err.name === 'AuthenticationError') return true
  return isStaleAuthErrorMessage(errorMessage(err))
}

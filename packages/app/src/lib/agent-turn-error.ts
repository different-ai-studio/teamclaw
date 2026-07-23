import type { TFunction } from 'i18next'

/** Classify daemon-emitted AcpError.message into a UI error name. */
export function classifyAgentTurnErrorName(message: string | undefined): string {
  const raw = (message ?? '').trim()
  const lower = raw.toLowerCase()
  if (lower === 'model stalled' || lower === 'model provider not responding') {
    return 'AgentTimeoutError'
  }
  if (lower === 'model provider error') {
    return 'ProviderError'
  }
  if (
    lower.includes('quota') ||
    lower.includes('usage limit') ||
    lower.includes('free usage') ||
    lower.includes('out of credit')
  ) {
    return 'RetryError'
  }
  return 'AgentError'
}

/** Localize known daemon turn-error messages; pass through anything else. */
export function localizeAgentTurnErrorMessage(
  message: string | undefined,
  t: TFunction,
): string {
  const raw = (message ?? '').trim()
  const lower = raw.toLowerCase()
  if (lower === 'model stalled' || lower === 'model provider not responding') {
    return t(
      'daemon.agentRuntime.providerStalled',
      'The model provider stopped responding. It may be unavailable or rate-limited — please retry or switch models.',
    )
  }
  if (lower === 'model provider error') {
    return t(
      'daemon.agentRuntime.providerError',
      'The model provider reported an error. Please retry or switch models.',
    )
  }
  return raw || t('errors.error', 'Error')
}

export function formatAgentTurnErrorDisplayMessage(
  localizedMessage: string,
  detail: string,
): string {
  const trimmedDetail = detail.trim()
  if (!trimmedDetail || trimmedDetail === localizedMessage) {
    return localizedMessage
  }
  return `${localizedMessage}: ${trimmedDetail}`
}

/** Turn errors that should stay visible until the user dismisses or sends again. */
export function isPersistentSessionTurnError(errorName: string | undefined): boolean {
  switch (errorName) {
    case 'RetryError':
    case 'AgentTimeoutError':
    case 'ProviderError':
      return true
    default:
      return false
  }
}

/** True when message text alone indicates quota / usage-limit exhaustion. */
export function isQuotaLikeAgentMessage(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('quota') ||
    lower.includes('usage limit') ||
    lower.includes('free usage') ||
    lower.includes('out of credit')
  )
}

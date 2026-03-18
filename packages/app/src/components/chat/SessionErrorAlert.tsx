import { useState } from 'react'
import { AlertCircle, ChevronDown, ChevronUp, RefreshCw, AlertTriangle, ShieldAlert, Timer, Copy, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { copyToClipboard } from '@/lib/utils'
import type { SessionErrorEvent } from '@/lib/opencode/types'

interface SessionErrorAlertProps {
  error: SessionErrorEvent | string
  onDismiss?: () => void
  onRetry?: () => void
}

interface ErrorStyle {
  icon: typeof AlertCircle
  title: string
  accentColor: string
  iconBg: string
}

export function SessionErrorAlert({ error, onDismiss, onRetry }: SessionErrorAlertProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const isStringError = typeof error === 'string'
  const errorName = isStringError ? '' : (error.error?.name || '')
  const rawError = isStringError ? undefined : (error.error as unknown as Record<string, unknown> | undefined)
  const errorMessage = isStringError
    ? error
    : (error.error?.data?.message
      || rawError?.message as string
      || (error as unknown as Record<string, unknown>).message as string
      || '')
  const statusCode = isStringError ? undefined : error.error?.data?.statusCode
  const providerID = isStringError ? undefined : error.error?.data?.providerID
  const isRetryable = isStringError ? false : error.error?.data?.isRetryable

  if (!errorMessage && !errorName) return null

  const isLongMessage = errorMessage.length > 150

  const getErrorStyle = (): ErrorStyle => {
    const lowerMsg = errorMessage.toLowerCase()
    if (
      errorName === 'RetryError' ||
      lowerMsg.includes('exceeded') ||
      lowerMsg.includes('quota') ||
      lowerMsg.includes('free usage')
    ) {
      return {
        icon: AlertTriangle,
        title: t('errors.quotaExceeded', 'Quota Exceeded'),
        accentColor: 'text-amber-600 dark:text-amber-400',
        iconBg: 'bg-amber-100 dark:bg-amber-900/40',
      }
    }
    if (errorName.includes('auth') || statusCode === 401) {
      return {
        icon: ShieldAlert,
        title: t('errors.authenticationError', 'Authentication Error'),
        accentColor: 'text-yellow-600 dark:text-yellow-400',
        iconBg: 'bg-yellow-100 dark:bg-yellow-900/40',
      }
    }
    if (statusCode === 429) {
      return {
        icon: Timer,
        title: t('errors.rateLimited', 'Rate Limited'),
        accentColor: 'text-orange-600 dark:text-orange-400',
        iconBg: 'bg-orange-100 dark:bg-orange-900/40',
      }
    }
    if (statusCode && statusCode >= 500) {
      return {
        icon: AlertCircle,
        title: t('errors.serverError', 'Server Error'),
        accentColor: 'text-red-600 dark:text-red-400',
        iconBg: 'bg-red-100 dark:bg-red-900/40',
      }
    }
    return {
      icon: AlertCircle,
      title: t('errors.error', 'Error'),
      accentColor: 'text-red-600 dark:text-red-400',
      iconBg: 'bg-red-100 dark:bg-red-900/40',
    }
  }

  const style = getErrorStyle()
  const Icon = style.icon

  const displayMessage = !expanded && isLongMessage
    ? errorMessage.slice(0, 150) + '…'
    : errorMessage

  const handleCopy = async () => {
    await copyToClipboard(errorMessage)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex justify-start mb-1.5 animate-in fade-in slide-in-from-bottom-1 duration-300">
      <div className="max-w-[85%] min-w-0">
        {/* Error header with icon */}
        <div className="flex items-center gap-2 mb-1.5 pl-1">
          <div className={`flex items-center justify-center h-6 w-6 rounded-full ${style.iconBg}`}>
            <Icon className={`h-3.5 w-3.5 ${style.accentColor}`} />
          </div>
          <span className={`text-xs font-semibold ${style.accentColor}`}>{style.title}</span>
          {statusCode && (
            <span className="text-[10px] font-mono text-muted-foreground/70 bg-muted px-1.5 py-0.5 rounded">
              {statusCode}
            </span>
          )}
          {providerID && (
            <span className="text-[10px] text-muted-foreground/60">
              {providerID}
            </span>
          )}
        </div>

        {/* Error message body */}
        <div className="rounded-2xl bg-red-50/80 dark:bg-red-950/20 border border-red-200/50 dark:border-red-800/30 px-4 py-3">
          <p className="text-[13px] leading-relaxed text-foreground/90 break-words [overflow-wrap:anywhere]">
            {displayMessage}
          </p>

          {isLongMessage && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="mt-1.5 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {expanded ? (
                <>
                  <ChevronUp className="h-3 w-3" />
                  {t('common.showLess', 'Show less')}
                </>
              ) : (
                <>
                  <ChevronDown className="h-3 w-3" />
                  {t('common.showMore', 'Show more')}
                </>
              )}
            </button>
          )}
        </div>

        {/* Action bar */}
        <div className="flex items-center gap-1 mt-1.5 pl-1">
          <button
            onClick={handleCopy}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? t('common.copied', 'Copied') : t('common.copy', 'Copy')}
          </button>

          {isRetryable && onRetry && (
            <button
              onClick={onRetry}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-primary hover:bg-primary/10 transition-colors"
            >
              <RefreshCw className="h-3 w-3" />
              {t('common.retry', 'Retry')}
            </button>
          )}

          {onDismiss && (
            <button
              onClick={onDismiss}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              {t('common.dismiss', 'Dismiss')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

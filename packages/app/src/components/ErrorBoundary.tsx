import { Component, type ErrorInfo, type ReactNode } from "react"
import i18n from "@/lib/i18n"
import { copyToClipboard } from "@/lib/utils"
import { AlertTriangle, RotateCw, Copy, ChevronDown, ChevronUp } from "lucide-react"

interface ErrorBoundaryProps {
  children: ReactNode
  /** Fallback UI when error occurs. If not provided, uses built-in fallback. */
  fallback?: ReactNode
  /** Called when an error is caught */
  onError?: (error: Error, errorInfo: ErrorInfo) => void
  /** Scope label shown in the error UI (e.g. "Chat", "File Editor") */
  scope?: string
  /** If true, shows a minimal inline error instead of full-page */
  inline?: boolean
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
  errorInfo: ErrorInfo | null
  showDetails: boolean
  copied: boolean
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      showDetails: false,
      copied: false,
    }
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.scope ? `:${this.props.scope}` : ""}] Caught error:`, error, errorInfo)
    this.setState({ errorInfo })
    this.props.onError?.(error, errorInfo)
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      showDetails: false,
      copied: false,
    })
  }

  handleCopy = () => {
    const { error, errorInfo } = this.state
    const text = [
      `Error: ${error?.message}`,
      `Stack: ${error?.stack}`,
      `Component Stack: ${errorInfo?.componentStack}`,
    ].join("\n\n")

    copyToClipboard(text).then(() => {
      this.setState({ copied: true })
      setTimeout(() => this.setState({ copied: false }), 2000)
    })
  }

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children
    }

    // Custom fallback
    if (this.props.fallback) {
      return this.props.fallback
    }

    const { error, errorInfo, showDetails, copied } = this.state
    const { scope, inline } = this.props

    // Inline (compact) error for sub-components
    if (inline) {
      return (
        <div className="flex flex-col items-center justify-center h-full p-4 gap-3">
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            <span className="text-sm font-medium">
              {scope ? `${scope} error` : i18n.t('errors.somethingWentWrong', 'Something went wrong')}
            </span>
          </div>
          <p className="text-xs text-muted-foreground text-center max-w-xs">
            {error?.message || i18n.t('errors.unexpectedError', 'An unexpected error occurred')}
          </p>
          <button
            onClick={this.handleReset}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <RotateCw className="h-3 w-3" />
            {i18n.t('common.retry', 'Retry')}
          </button>
        </div>
      )
    }

    // Full-page error for global boundary
    return (
      <div className="flex items-center justify-center min-h-screen bg-background p-8">
        <div className="flex flex-col items-center gap-6 max-w-lg w-full">
          {/* Icon */}
          <div className="rounded-full bg-destructive/10 p-4">
            <AlertTriangle className="h-12 w-12 text-destructive" />
          </div>

          {/* Title & description */}
          <div className="text-center space-y-2">
            <h1 className="text-xl font-semibold text-foreground">
              {scope ? `${scope} Crashed` : i18n.t('errors.applicationError', 'Application Error')}
            </h1>
            <p className="text-sm text-muted-foreground">
              {i18n.t('errors.recoveryHint', 'An unexpected error occurred. You can try to recover or reload the application.')}
            </p>
          </div>

          {/* Error message */}
          <div className="w-full rounded-lg border bg-muted/50 p-4">
            <p className="text-sm font-mono text-destructive break-words">
              {error?.message || i18n.t('errors.unknownError', 'Unknown error')}
            </p>
          </div>

          {/* Action buttons */}
          <div className="flex gap-3">
            <button
              onClick={this.handleReset}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <RotateCw className="h-4 w-4" />
              {i18n.t('errors.tryAgain', 'Try Again')}
            </button>
            <button
              onClick={this.handleReload}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md border bg-background hover:bg-muted transition-colors"
            >
              {i18n.t('errors.reloadApp', 'Reload App')}
            </button>
          </div>

          {/* Error details (collapsible) */}
          <div className="w-full">
            <button
              onClick={() => this.setState({ showDetails: !showDetails })}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {showDetails ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
              {i18n.t('errors.errorDetails', 'Error Details')}
            </button>

            {showDetails && (
              <div className="mt-2 relative">
                <button
                  onClick={this.handleCopy}
                  className="absolute top-2 right-2 p-1.5 rounded hover:bg-muted-foreground/20 text-muted-foreground transition-colors"
                  title={i18n.t('errors.copyDetails', 'Copy error details')}
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
                {copied && (
                  <span className="absolute top-2 right-10 text-xs text-green-600">
                    {i18n.t('common.copied', 'Copied!')}
                  </span>
                )}
                <pre className="rounded-lg border bg-muted/30 p-4 pr-10 text-xs font-mono text-muted-foreground overflow-auto max-h-64 whitespace-pre-wrap break-words">
                  {error?.stack}
                  {errorInfo?.componentStack && (
                    <>
                      {"\n\nComponent Stack:"}
                      {errorInfo.componentStack}
                    </>
                  )}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }
}

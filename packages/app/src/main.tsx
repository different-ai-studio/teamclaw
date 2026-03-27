import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/react'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles/globals.css'
import './stores/dev-expose'
import './lib/i18n'; // Initialize i18n
import { appShortName, buildConfig } from './lib/build-config'

// Initialize Sentry for frontend error tracking
Sentry.init({
  dsn: 'https://87ad99c36806946fe743be71ed87fffe@o60909.ingest.us.sentry.io/4511110370295808',
  release: `teamclaw-web@${import.meta.env.PACKAGE_VERSION ?? '0.0.0'}`,
  environment: import.meta.env.DEV ? 'development' : 'production',
  sendDefaultPii: true,
})

// Apply persisted theme immediately to prevent flash of wrong theme
;(() => {
  const theme = localStorage.getItem(`${appShortName}-theme`) || buildConfig.defaults?.theme || 'system'
  const root = document.documentElement
  if (theme === 'dark') {
    root.classList.add('dark')
  } else if (theme === 'system') {
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      root.classList.add('dark')
    }
  }
})()

// Global unhandled error logging
window.addEventListener('unhandledrejection', (event) => {
  console.error('[Global] Unhandled promise rejection:', event.reason)
  Sentry.captureException(event.reason)
})

// Disable browser context menu for native desktop feel
// Allow it only in dev mode via Ctrl+Shift+RightClick
document.addEventListener('contextmenu', (event) => {
  if (import.meta.env.DEV && event.ctrlKey && event.shiftKey) return
  event.preventDefault()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary scope="TeamClaw">
      <App />
    </ErrorBoundary>
  </StrictMode>,
)

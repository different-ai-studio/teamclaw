import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles/globals.css'
import './lib/i18n'; // Initialize i18n

// Apply persisted theme immediately to prevent flash of wrong theme
;(() => {
  const theme = localStorage.getItem('teamclaw-theme') || 'system'
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

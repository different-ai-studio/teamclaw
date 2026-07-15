import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/react'
import { invoke } from '@tauri-apps/api/core'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { AuthGate } from './components/auth/AuthGate'
import './styles/globals.css'
import './stores/dev-expose'
import './lib/i18n'; // Initialize i18n
import { appShortName, buildConfig } from './lib/build-config'
import { ensureBundledAmuxdCurrent } from './lib/daemon-version-upgrade'
import { initJwtBridge } from './lib/jwt-bridge'
import { markStartup } from './lib/startup-perf'
import { removeStartupSkeleton } from './lib/utils'

markStartup('main:start')

// Sync the Supabase JWT into teamclaw.json so FC-backed commands (team share,
// LiteLLM, OSS sync) can authenticate. Must run at startup, before any of those
// features open. No-op outside Tauri.
initJwtBridge()
void ensureBundledAmuxdCurrent()

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
  // Build-flavor palette (mirrors the index.html early script). No-op for the
  // default Editorial Calm palette.
  const palette = buildConfig.app?.palette
  if (palette && palette !== 'default') {
    root.setAttribute('data-palette', palette)
  }
})()

// Text entry defaults to command/config/chat style input. Mobile WebView and
// some IMEs otherwise auto-capitalize the first Latin character, which is wrong
// for paths, identifiers, prompts, feedback, and mixed Chinese/English text.
function applyTextEntryDefaults(root: ParentNode) {
  root
    .querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLElement>(
      'input, textarea, [contenteditable="true"]',
    )
    .forEach((el) => {
      if (!el.hasAttribute('autocapitalize')) el.setAttribute('autocapitalize', 'off')
      if (!el.hasAttribute('autocorrect')) el.setAttribute('autocorrect', 'off')
    })
}

applyTextEntryDefaults(document)
new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node instanceof HTMLElement) {
        applyTextEntryDefaults(node)
      }
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true })

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

// Mirror the macOS user-chosen accent color onto a CSS variable so focus
// rings and selection states track what the rest of the OS does. Returns
// null on Windows/Linux today; CSS falls back to the brand `--ring`.
invoke<string | null>('get_system_accent_color')
  .then((hex) => {
    if (hex) document.documentElement.style.setProperty('--system-accent', hex)
  })
  .catch(() => { /* non-tauri context or pre-init — fall through */ })

markStartup('react-mount')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary scope="TeamClaw">
      <AuthGate>
        <App />
      </AuthGate>
    </ErrorBoundary>
  </StrictMode>,
)

// Backstop: the skeleton is normally handed off by AuthGate/App once real UI is
// ready (see removeStartupSkeleton call sites). If startup wedges before any of
// those fire, force it down after a generous deadline so the user is never stuck
// staring at a frozen skeleton with no way forward.
setTimeout(() => removeStartupSkeleton(), 20000)

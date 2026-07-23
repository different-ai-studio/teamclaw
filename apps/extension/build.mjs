// apps/extension/build.mjs
import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dist = resolve(here, 'dist')
const appDir = resolve(here, '../../packages/app')
const linkHoverShared = resolve(appDir, 'src/lib/extension-link-hover')
const linkSessionShared = resolve(appDir, 'src/lib/extension-link-session')

const esbuildAlias = {
  '@teamclaw/extension-link-hover': resolve(linkHoverShared, 'index.ts'),
  '@teamclaw/extension-link-session': resolve(linkSessionShared, 'index.ts'),
}

/** SOLO=1 or `--solo` → solo-agent build (hide permission control + model on mention pills). */
const isSolo =
  process.env.SOLO === '1' ||
  process.env.SOLO === 'true' ||
  process.argv.includes('--solo')

/**
 * DOMAINS / `--domains=` → comma-separated host allowlist for the side panel.
 * Empty = ungated (global singleton panel on any site).
 * Example: DOMAINS="*.shopee.io,admin.example.com" pnpm --filter @teamclaw/extension build
 */
function readDomains() {
  const fromEnv = process.env.DOMAINS?.trim()
  if (fromEnv) return fromEnv
  const arg = process.argv.find((a) => a.startsWith('--domains='))
  if (arg) return arg.slice('--domains='.length).trim()
  return ''
}

const domainsRaw = readDomains()

const esbuildAliasWithAllowlist = {
  ...esbuildAlias,
  '@teamclaw/side-panel-host-allowlist': resolve(appDir, 'src/lib/side-panel-host-allowlist.ts'),
}

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

// 1) Build the web app in forced-embed mode with relative base.
// EXT_ENV=test targets the wss-capable self-host test deployment
// (.env.web.test); otherwise the default .env.web is used.
const webBuildScript = process.env.EXT_ENV === 'test' ? 'build:web:test' : 'build:web'
console.log(
  '[extension] web build ->',
  webBuildScript,
  isSolo ? '(solo)' : '',
  domainsRaw ? `(domains: ${domainsRaw})` : '',
)
execSync(`pnpm ${webBuildScript}`, {
  cwd: appDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    VITE_APP_PLATFORM: 'web',
    VITE_FORCE_EMBED: 'chat',
    ...(isSolo ? { VITE_SOLO: 'true' } : {}),
    ...(domainsRaw ? { VITE_SIDE_PANEL_DOMAINS: domainsRaw } : {}),
  },
})
cpSync(resolve(appDir, 'dist'), resolve(dist, 'sidepanel'), { recursive: true })

// 2) Bundle background (module worker) + content script (IIFE).
await build({
  entryPoints: { background: resolve(here, 'src/background.ts') },
  outdir: dist, bundle: true, format: 'esm', target: 'chrome110', platform: 'browser',
  alias: esbuildAliasWithAllowlist,
  define: {
    __SIDE_PANEL_DOMAINS__: JSON.stringify(domainsRaw),
  },
})
await build({
  entryPoints: { 'content-script': resolve(here, 'src/content-script.ts') },
  outdir: dist, bundle: true, format: 'iife', target: 'chrome110', platform: 'browser',
  alias: esbuildAliasWithAllowlist,
})

// 3) Copy manifest + icons.
cpSync(resolve(here, 'manifest.json'), resolve(dist, 'manifest.json'))
if (existsSync(resolve(here, 'icons'))) {
  cpSync(resolve(here, 'icons'), resolve(dist, 'icons'), { recursive: true })
}
console.log('[extension] built ->', dist)

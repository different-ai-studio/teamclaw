// apps/extension/build.mjs
import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dist = resolve(here, 'dist')
const repoRoot = resolve(here, '../..')
const appDir = resolve(here, '../../packages/app')
const linkHoverShared = resolve(appDir, 'src/lib/extension-link-hover')
const linkSessionShared = resolve(appDir, 'src/lib/extension-link-session')
const nodeRequire = createRequire(import.meta.url)
const { parseExtensionsConfig, domainsToSidePanelCsv } = nodeRequire(
  resolve(repoRoot, 'scripts/lib/extension-config.js'),
)

const esbuildAlias = {
  '@teamclaw/extension-link-hover': resolve(linkHoverShared, 'index.ts'),
  '@teamclaw/extension-link-session': resolve(linkSessionShared, 'index.ts'),
}

function readJSON(filePath) {
  try {
    if (!existsSync(filePath)) return null
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

function deepMerge(base, overlay) {
  if (!overlay) return base
  const result = { ...base }
  for (const key of Object.keys(overlay)) {
    const baseVal = result[key]
    const overVal = overlay[key]
    if (
      baseVal &&
      overVal &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal) &&
      typeof overVal === 'object' &&
      !Array.isArray(overVal)
    ) {
      result[key] = deepMerge(baseVal, overVal)
    } else if (overVal !== undefined) {
      result[key] = overVal
    }
  }
  return result
}

/** Same merge as packages/app/vite.config.ts — base + build.config.<BUILD_ENV>.json. */
function loadMergedBuildConfig() {
  const { resolveBuildEnv } = nodeRequire(resolve(repoRoot, 'scripts/lib/resolve-build-env.js'))
  const buildEnv = resolveBuildEnv(repoRoot)
  const baseConfig = readJSON(resolve(repoRoot, 'build.config.json')) || {}
  const envConfig = buildEnv ? readJSON(resolve(repoRoot, `build.config.${buildEnv}.json`)) : null
  return deepMerge(baseConfig, envConfig)
}

const mergedBuildConfig = loadMergedBuildConfig()
const extensionPack = parseExtensionsConfig(mergedBuildConfig.extensions)
const domainsCsv = domainsToSidePanelCsv(extensionPack.domains)
const extensionSettingsBake = extensionPack.settings

const esbuildAliasWithAllowlist = {
  ...esbuildAlias,
  '@teamclaw/side-panel-host-allowlist': resolve(appDir, 'src/lib/side-panel-host-allowlist.ts'),
}

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

// 1) Build the web app in forced-embed mode with relative base.
// EXT_ENV=test targets the wss-capable self-host test deployment
// (.env.web.test); otherwise the default .env.web is used.
// solo / domains come from build.config*.json → extensions (baked via __BUILD_CONFIG__).
const webBuildScript = process.env.EXT_ENV === 'test' ? 'build:web:test' : 'build:web'
console.log(
  '[extension] web build ->',
  webBuildScript,
  extensionPack.solo ? '(solo)' : '',
  domainsCsv ? `(domains: ${domainsCsv})` : '(domains: ungated)',
)
execSync(`pnpm ${webBuildScript}`, {
  cwd: appDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    VITE_APP_PLATFORM: 'web',
    VITE_FORCE_EMBED: 'chat',
  },
})
cpSync(resolve(appDir, 'dist'), resolve(dist, 'sidepanel'), { recursive: true })

// 2) Bundle background (module worker) + content script (IIFE).
await build({
  entryPoints: { background: resolve(here, 'src/background.ts') },
  outdir: dist, bundle: true, format: 'esm', target: 'chrome110', platform: 'browser',
  alias: esbuildAliasWithAllowlist,
  define: {
    __SIDE_PANEL_DOMAINS__: JSON.stringify(domainsCsv),
  },
})
await build({
  entryPoints: { 'content-script': resolve(here, 'src/content-script.ts') },
  outdir: dist, bundle: true, format: 'iife', target: 'chrome110', platform: 'browser',
  alias: esbuildAliasWithAllowlist,
  define: {
    __TEAMCLAW_EXTENSION_SETTINGS__: JSON.stringify(extensionSettingsBake),
  },
})

// 3) Copy manifest + icons.
cpSync(resolve(here, 'manifest.json'), resolve(dist, 'manifest.json'))
if (existsSync(resolve(here, 'icons'))) {
  cpSync(resolve(here, 'icons'), resolve(dist, 'icons'), { recursive: true })
}
console.log('[extension] built ->', dist)

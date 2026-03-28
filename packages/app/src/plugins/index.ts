// packages/app/src/plugins/index.ts
export async function loadPlugins() {
  // Dynamically load optional plugins if installed.
  // Pro plugin: pnpm add @teamclaw/plugin-team
  try {
    await import('@teamclaw/plugin-team')
  } catch {
    // Plugin not installed — open-source build, skip silently.
  }
}

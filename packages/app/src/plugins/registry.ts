// packages/app/src/plugins/registry.ts
import type { TeamClawPlugin } from './types'

const plugins: Map<string, TeamClawPlugin> = new Map()

export function registerPlugin(plugin: TeamClawPlugin) {
  plugins.set(plugin.id, plugin)
}

export function getPlugins(): TeamClawPlugin[] {
  return [...plugins.values()]
}

export function getPlugin(id: string): TeamClawPlugin | undefined {
  return plugins.get(id)
}

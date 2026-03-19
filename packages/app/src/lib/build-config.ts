// Build-time configuration injected by Vite's `define` from build.config.json.
// See build.config.example.json for all available fields.

export interface BuildConfig {
  team: {
    llm: {
      baseUrl: string
      model: string
      modelName: string
    }
    lockLlmConfig: boolean
  }
  app: {
    name: string
  }
  features: {
    advancedMode: boolean
    teamMode: boolean
    updater: boolean
  }
  defaults: {
    locale: string
    theme: string
  }
}

const fallback: BuildConfig = {
  team: {
    llm: { baseUrl: '', model: '', modelName: '' },
    lockLlmConfig: false,
  },
  app: { name: 'TeamClaw' },
  features: { advancedMode: true, teamMode: true, updater: true },
  defaults: { locale: 'zh-CN', theme: 'system' },
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deepMerge(base: any, override: any): any {
  if (!override) return base
  const result = { ...base }
  for (const key of Object.keys(override)) {
    const baseVal = result[key]
    const overVal = override[key]
    if (
      baseVal && overVal &&
      typeof baseVal === 'object' && !Array.isArray(baseVal) &&
      typeof overVal === 'object' && !Array.isArray(overVal)
    ) {
      result[key] = deepMerge(baseVal, overVal)
    } else if (overVal !== undefined) {
      result[key] = overVal
    }
  }
  return result
}

export const buildConfig: BuildConfig = typeof __BUILD_CONFIG__ !== 'undefined' && __BUILD_CONFIG__
  ? deepMerge(fallback, __BUILD_CONFIG__) as BuildConfig
  : fallback

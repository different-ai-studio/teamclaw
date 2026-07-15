import {
  DEFAULT_LINK_HOVER_CONFIG,
  LINK_HOVER_CONFIG_KEY,
  type LinkHoverConfig,
  parseLinkHoverConfig,
} from './config'

type ChromeStorageLocal = {
  get: (keys: string | string[]) => Promise<Record<string, unknown>>
  set: (items: Record<string, unknown>) => Promise<void>
}

type ChromeStorage = {
  local?: ChromeStorageLocal
  onChanged?: {
    addListener: (
      listener: (
        changes: Record<string, { newValue?: unknown }>,
        areaName: string,
      ) => void,
    ) => void
    removeListener: (
      listener: (
        changes: Record<string, { newValue?: unknown }>,
        areaName: string,
      ) => void,
    ) => void
  }
}

function readChromeStorage(): ChromeStorage | undefined {
  return (globalThis as { chrome?: { storage?: ChromeStorage } }).chrome?.storage
}

export async function readLinkHoverConfig(): Promise<LinkHoverConfig> {
  const storage = readChromeStorage()?.local
  if (!storage) return { ...DEFAULT_LINK_HOVER_CONFIG }

  try {
    const bag = await storage.get(LINK_HOVER_CONFIG_KEY)
    return parseLinkHoverConfig(bag[LINK_HOVER_CONFIG_KEY])
  } catch {
    return { ...DEFAULT_LINK_HOVER_CONFIG }
  }
}

export async function writeLinkHoverConfig(config: LinkHoverConfig): Promise<void> {
  const storage = readChromeStorage()?.local
  if (!storage) return

  const parsed = parseLinkHoverConfig(config)
  await storage.set({ [LINK_HOVER_CONFIG_KEY]: parsed })
}

export function watchLinkHoverConfig(
  onChange: (config: LinkHoverConfig) => void,
): () => void {
  const storage = readChromeStorage()
  if (!storage?.onChanged) return () => {}

  const listener = (
    changes: Record<string, { newValue?: unknown }>,
    areaName: string,
  ) => {
    if (areaName !== 'local') return
    if (!(LINK_HOVER_CONFIG_KEY in changes)) return
    onChange(parseLinkHoverConfig(changes[LINK_HOVER_CONFIG_KEY]?.newValue))
  }

  storage.onChanged.addListener(listener)
  return () => storage.onChanged?.removeListener(listener)
}

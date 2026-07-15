import { useState, useEffect } from "react"

const FALLBACK_VERSION = "0.2.3"

let cachedVersion: string | null = null

async function fetchAppVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion

  try {
    const { getVersion } = await import("@tauri-apps/api/app")
    cachedVersion = await getVersion()
    return cachedVersion
  } catch {
    // Not in Tauri environment (e.g. dev browser)
    cachedVersion = FALLBACK_VERSION
    return cachedVersion
  }
}

export function useAppVersion(): string {
  const [version, setVersion] = useState(cachedVersion || FALLBACK_VERSION)

  useEffect(() => {
    fetchAppVersion().then(setVersion)
  }, [])

  return version
}

export function getAppVersion(): string {
  return cachedVersion || FALLBACK_VERSION
}

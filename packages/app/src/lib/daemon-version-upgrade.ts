import { buildConfig } from '@/lib/build-config'
import { isTauri } from '@/lib/utils'

type RequirementStatus = {
  id: string
  present: boolean
  version: string | null
}

let inFlight: Promise<void> | null = null

/**
 * Production updater installs the new desktop bundle first; on the next launch,
 * this backstop copies that bundle's amuxd sidecar into ~/.amuxd/bin when the
 * installed daemon is older than the bundled one. First-time missing installs
 * stay in the setup wizard so onboarding remains explicit.
 */
export function ensureBundledAmuxdCurrent(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = runEnsureBundledAmuxdCurrent().finally(() => {
    inFlight = null
  })
  return inFlight
}

async function runEnsureBundledAmuxdCurrent(): Promise<void> {
  if (!isTauri()) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const requirements = await invoke<RequirementStatus[]>('setup_list_requirements')
    const amuxd = requirements.find((item) => item.id === 'amuxd')
    if (!amuxd || amuxd.present || !amuxd.version) return

    await invoke('setup_install', {
      id: 'amuxd',
      opencodeDownloadBase: buildConfig.opencode?.downloadBase ?? '',
    })
  } catch (err) {
    console.warn('[daemon-upgrade] failed to ensure bundled amuxd is current', err)
  }
}

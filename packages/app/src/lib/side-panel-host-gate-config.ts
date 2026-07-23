import {
  isSidePanelHostGateEnabled,
  parseSidePanelDomainPatterns,
} from './side-panel-host-allowlist'

/** Patterns baked into the extension web build (empty = ungated). */
export function getConfiguredSidePanelDomainPatterns(): string[] {
  return parseSidePanelDomainPatterns(import.meta.env.VITE_SIDE_PANEL_DOMAINS)
}

export function isConfiguredSidePanelHostGateEnabled(): boolean {
  return isSidePanelHostGateEnabled(getConfiguredSidePanelDomainPatterns())
}

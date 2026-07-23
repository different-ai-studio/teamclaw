import { extensionSidePanelDomains } from '@/lib/build-config'
import { isSidePanelHostGateEnabled } from './side-panel-host-allowlist'

/** Patterns baked into the extension web build (empty = ungated). */
export function getConfiguredSidePanelDomainPatterns(): string[] {
  return [...extensionSidePanelDomains]
}

export function isConfiguredSidePanelHostGateEnabled(): boolean {
  return isSidePanelHostGateEnabled(getConfiguredSidePanelDomainPatterns())
}

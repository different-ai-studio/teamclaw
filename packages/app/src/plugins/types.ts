// packages/app/src/plugins/types.ts
import type { ComponentType, LazyExoticComponent } from 'react'

export interface PluginSettingsSection {
  id: string
  label: string
  labelKey: string
  icon: ComponentType
  component: LazyExoticComponent<ComponentType> | ComponentType
  group: 'primary' | 'advanced'
  color?: string
}

export interface PluginSidebarWidget {
  position: 'top' | 'bottom'
  component: ComponentType
}

export interface TeamClawPlugin {
  id: string
  settingsSections?: PluginSettingsSection[]
  useInit?: () => void
  sidebarWidgets?: PluginSidebarWidget[]
  onWorkspaceChange?: (workspacePath: string) => void
  onWorkspaceReset?: () => void
  onTelemetryEvent?: (event: string) => void
}

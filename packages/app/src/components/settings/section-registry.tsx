import * as React from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { SettingsSection } from '@/stores/ui'
import { LLMSection } from './LLMSection'
import { GeneralSection } from './GeneralSection'
import { PromptSection } from './PromptSection'
import { MCPSection } from './MCPSection'
import { SkillsSection } from './SkillsSection'
import { RolesSection } from './RolesSection'
import { RolesSkillsSection } from './RolesSkillsSection'
import { ChannelsSection } from './ChannelsSection'
import { DaemonGeneralSection } from './DaemonGeneralSection'
import { DaemonWorkspacesSection } from './DaemonWorkspacesSection'
import { DaemonRuntimesSection } from './DaemonRuntimesSection'
import { DependenciesSection } from './DependenciesSection'
import { TeamSection } from './TeamSection'
import { CronSection } from './CronSection'
import { EnvVarsSection } from './EnvVarsSection'
import { TokenUsageSection } from './TokenUsageSection'
import { PrivacySection } from './PrivacySection'
import { KnowledgeSection } from './KnowledgeSection'
import { VoiceSection } from './VoiceSection'
import { LeaderboardSection } from './LeaderboardSection'
import { PermissionManagementSection } from './PermissionManagementSection'
import { ShortcutsSection } from '@/components/shortcuts/ShortcutsSection'
import { CacheSection } from './CacheSection'

export const SETTINGS_SECTION_COMPONENTS: Record<SettingsSection, React.ComponentType> = {
  llm: LLMSection,
  general: GeneralSection,
  voice: VoiceSection,
  prompt: PromptSection,
  mcp: MCPSection,
  channels: ChannelsSection,
  automation: CronSection,
  daemonGeneral: DaemonGeneralSection,
  daemonWorkspaces: DaemonWorkspacesSection,
  daemonRuntimes: DaemonRuntimesSection,
  team: TeamSection,
  envVars: EnvVarsSection,
  skills: SkillsSection,
  roles: RolesSection,
  rolesSkills: RolesSkillsSection,
  knowledge: KnowledgeSection,
  deps: DependenciesSection,
  tokenUsage: TokenUsageSection,
  privacy: PrivacySection,
  permissions: PermissionManagementSection,
  leaderboard: LeaderboardSection,
  shortcuts: ShortcutsSection,
  cache: CacheSection,
}

export function SettingsSectionBody({ section }: { section: SettingsSection }) {
  const Component = SETTINGS_SECTION_COMPONENTS[section]
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {/*
        Radix ScrollArea's Viewport wraps children in an inline-styled
        `display:table; min-width:100%` div, which shrink-to-fits to the
        content's max-content width. Any non-wrapping descendant (e.g. a
        `truncate` URL = white-space:nowrap, or a long path) then forces that
        table wider than the pane, and the outer `overflow-hidden` clips it on
        the right. Force the viewport's inner wrapper to `display:block` so it
        respects the pane width and our `max-w-[960px]` content wraps/truncates
        instead of overflowing. Scoped to this ScrollArea via its data-slot.
      */}
      <ScrollArea className="h-full min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
        <div className="w-full min-w-0 max-w-[960px] p-8 pr-10">
          {React.createElement(Component)}
        </div>
      </ScrollArea>
    </div>
  )
}

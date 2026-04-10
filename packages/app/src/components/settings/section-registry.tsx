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
import { DependenciesSection } from './DependenciesSection'
import { TeamSection } from './TeamSection'
import { CronSection } from './CronSection'
import { EnvVarsSection } from './EnvVarsSection'
import { TokenUsageSection } from './TokenUsageSection'
import { PrivacySection } from './PrivacySection'
import { KnowledgeSection } from './KnowledgeSection'
import { PermissionManagementSection } from './PermissionManagementSection'
import { VoiceSection } from './VoiceSection'
import { LeaderboardSection } from './LeaderboardSection'
import { ShortcutsSection } from '@/components/shortcuts/ShortcutsSection'
import { MobileRelaySettings } from './MobileRelaySettings'

export const SETTINGS_SECTION_COMPONENTS: Record<SettingsSection, React.ComponentType> = {
  llm: LLMSection,
  general: GeneralSection,
  voice: VoiceSection,
  prompt: PromptSection,
  mcp: MCPSection,
  channels: ChannelsSection,
  automation: CronSection,
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
  mobileRelay: MobileRelaySettings,
}

export function SettingsSectionBody({ section }: { section: SettingsSection }) {
  const Component = SETTINGS_SECTION_COMPONENTS[section]
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/5">
      <ScrollArea className="h-full min-h-0 flex-1">
        <div className={section === 'rolesSkills' ? "mx-auto max-w-[68rem] p-6" : "max-w-2xl mx-auto p-8"}>
          {React.createElement(Component)}
        </div>
      </ScrollArea>
    </div>
  )
}

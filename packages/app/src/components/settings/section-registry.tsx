import * as React from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { SettingsSection } from '@/stores/ui'
import { GeneralSection } from './GeneralSection'
import { ChannelsSection } from './ChannelsSection'
import { TeamSection } from './TeamSection'
import { EnvVarsSection } from './EnvVarsSection'
import { TokenUsageSection } from './TokenUsageSection'
import { PrivacySection } from './PrivacySection'
import { KnowledgeSection } from './KnowledgeSection'
import { VoiceSection } from './VoiceSection'
import { LeaderboardSection } from './LeaderboardSection'
import { ShortcutsSection } from '@/components/shortcuts/ShortcutsSection'
import { CacheSection } from './CacheSection'

export const SETTINGS_SECTION_COMPONENTS: Record<SettingsSection, React.ComponentType> = {
  general: GeneralSection,
  voice: VoiceSection,
  channels: ChannelsSection,
  team: TeamSection,
  envVars: EnvVarsSection,
  knowledge: KnowledgeSection,
  tokenUsage: TokenUsageSection,
  privacy: PrivacySection,
  leaderboard: LeaderboardSection,
  shortcuts: ShortcutsSection,
  cache: CacheSection,
}

export function SettingsSectionBody({ section }: { section: SettingsSection }) {
  const Component = SETTINGS_SECTION_COMPONENTS[section]
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <ScrollArea className="h-full min-h-0 flex-1">
        <div className="mx-auto max-w-2xl p-8 pr-10">
          {React.createElement(Component)}
        </div>
      </ScrollArea>
    </div>
  )
}

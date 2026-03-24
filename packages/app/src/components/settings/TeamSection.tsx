import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Users,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { TeamP2PConfig } from './team/TeamP2PConfig'

// ─── Section Header ──────────────────────────────────────────────────────────

function SectionHeader({
  icon: Icon,
  title,
  description,
  iconColor,
}: {
  icon: React.ElementType
  title: string
  description: string
  iconColor: string
}) {
  return (
    <div className="flex items-start gap-4 mb-6">
      <div className="rounded-xl p-3 bg-muted/50">
        <Icon className={cn("h-6 w-6", iconColor)} />
      </div>
      <div>
        <h3 className="text-xl font-semibold tracking-tight">{title}</h3>
        <p className="text-sm text-muted-foreground mt-1">{description}</p>
      </div>
    </div>
  )
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function TeamSection() {
  const { t } = useTranslation()

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Users}
        title={t('settings.team.title', 'Team')}
        description={t('settings.team.description', '连接云存储以与团队共享技能、MCP 配置和知识库')}
        iconColor="text-violet-500"
      />

      <TeamP2PConfig />
    </div>
  )
}

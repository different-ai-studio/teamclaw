import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { MousePointerClick, Plug, Box } from 'lucide-react'
import { toast } from 'sonner'
import { useUIStore } from '@/stores/ui'
import { useWorkspaceStore } from '@/stores/workspace'
import { useTeamShareBrowserStore, type TeamShareSection } from '@/stores/team-share-browser'
import { SkillDetail } from './SkillDetail'
import { KnowledgeDetail } from './KnowledgeDetail'
import { McpDetail, McpEditForm } from './McpDetail'
import { EnvDetail, EnvCreateForm } from './EnvDetail'

function EmptyState({ section }: { section: TeamShareSection }) {
  const { t } = useTranslation()
  const label = t(`teamShare.${section}`, section)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <MousePointerClick className="h-8 w-8 text-muted-foreground/40" />
      <p className="text-[13px] text-muted-foreground">
        {t('teamShare.selectPrompt', 'Select a {{section}} item to view it here.', { section: label })}
      </p>
    </div>
  )
}

/** Compose surface for a new item. Authoring happens here, never in the list. */
function CreatePane({ section }: { section: 'mcp' | 'env' }) {
  const { t } = useTranslation()
  // The env form owns the scope toggle, but the title sits in this header — so
  // it reports back rather than the header guessing.
  const [envScope, setEnvScope] = React.useState<'team' | 'personal'>('team')
  const setCreating = useTeamShareBrowserStore((s) => s.setCreating)
  const createMcp = useTeamShareBrowserStore((s) => s.createMcp)
  const loadCounts = useTeamShareBrowserStore((s) => s.loadCounts)
  const Icon = section === 'mcp' ? Plug : Box

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3" data-tauri-drag-region>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="h-[17px] w-[17px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-faint">
            {section === 'mcp'
              ? t('teamShare.mcpDetail.server', 'MCP Server')
              : t('teamShare.env', 'Team Env')}
          </div>
          <div className="truncate text-[15px] font-bold text-foreground">
            {section === 'mcp'
              ? t('teamShare.mcpAdd', 'Add MCP server')
              : envScope === 'team'
                ? t('teamShare.envAddTeam', 'Add team env key')
                : t('teamShare.envAddPersonal', 'Add personal env key')}
          </div>
        </div>
      </div>

      <div className="px-6 py-5">
        {section === 'mcp' ? (
          <McpEditForm
            submitLabel={t('teamShare.mcpAddSubmit', 'Add to team')}
            onCancel={() => setCreating(null)}
            onSubmit={async (input) => {
              await createMcp(input)
              setCreating(null)
              toast.success(
                t(
                  'teamShare.mcpAdded',
                  'Added to the team catalog. Install it to run it on this machine.',
                ),
              )
            }}
          />
        ) : (
          <EnvCreateForm
            onScopeChange={setEnvScope}
            onCancel={() => setCreating(null)}
            onDone={() => {
              setCreating(null)
              void loadCounts()
            }}
          />
        )}
      </div>
    </div>
  )
}

export function TeamShareDetailPane() {
  const filter = useUIStore((s) => s.sidebarFilter)
  const section = filter.kind === 'teamShare' ? filter.section : null
  const selectedId = useTeamShareBrowserStore((s) => (section ? s.selectedId[section] : null))
  const creating = useTeamShareBrowserStore((s) => s.creating)
  // Knowledge is a file tree now: clicking a node goes through the workspace's
  // own selectFile, so the pane follows selectedFile rather than a curated id.
  const selectedFile = useWorkspaceStore((s) => s.selectedFile)

  if (!section) return null
  if (creating === section && (section === 'mcp' || section === 'env')) {
    return <CreatePane section={section} />
  }
  if (section === 'knowledge') {
    if (!selectedFile) return <EmptyState section={section} />
    return <KnowledgeDetail key={selectedFile} path={selectedFile} />
  }
  if (!selectedId) return <EmptyState section={section} />

  switch (section) {
    case 'skills':
      return <SkillDetail key={selectedId} slug={selectedId} />
    case 'mcp':
      return <McpDetail key={selectedId} name={selectedId} />
    case 'env':
      return <EnvDetail key={selectedId} keyId={selectedId} />
    default:
      return null
  }
}

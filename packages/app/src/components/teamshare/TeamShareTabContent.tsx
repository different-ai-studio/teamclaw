import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Plug, Box } from 'lucide-react'
import { toast } from 'sonner'
import { useTeamShareBrowserStore } from '@/stores/team-share-browser'
import { useTabsStore } from '@/stores/tabs'
import {
  encodeTeamShareTarget,
  type TeamShareTabTarget,
} from '@/lib/tabs/teamshare-target'
import { SkillDetail } from './SkillDetail'
import { SkillFileEditor } from './SkillFileEditor'
import { McpDetail, McpEditForm } from './McpDetail'
import { EnvDetail, EnvCreateForm } from './EnvDetail'

/**
 * Compose surface for a new item. Authoring happens here, never in the list.
 *
 * Closing it closes the tab: the form *is* the tab now, so leaving an empty
 * "create" tab behind after submitting would be a window onto nothing.
 */
function CreatePane({ section }: { section: 'mcp' | 'env' }) {
  const { t } = useTranslation()
  // The env form owns the scope toggle, but the title sits in this header — so
  // it reports back rather than the header guessing.
  const [envScope, setEnvScope] = React.useState<'team' | 'personal'>('team')
  const createMcp = useTeamShareBrowserStore((s) => s.createMcp)
  const loadCounts = useTeamShareBrowserStore((s) => s.loadCounts)
  const Icon = section === 'mcp' ? Plug : Box

  const close = React.useCallback(() => {
    const target = encodeTeamShareTarget({ kind: 'create', section })
    const tab = useTabsStore.getState().tabs.find((x) => x.type === 'native' && x.target === target)
    if (tab) useTabsStore.getState().closeTab(tab.id)
  }, [section])

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
            onCancel={close}
            onSubmit={async (input) => {
              await createMcp(input)
              close()
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
            onCancel={close}
            onDone={() => {
              close()
              void loadCounts()
            }}
          />
        )}
      </div>
    </div>
  )
}

/** Renders whichever team-share view a tab target names. */
export function TeamShareTabContent({ target }: { target: TeamShareTabTarget }) {
  switch (target.kind) {
    case 'skill':
      return <SkillDetail key={target.id} slug={target.id} />
    case 'skill-file':
      return (
        <SkillFileEditor
          key={`${target.id}:${target.rel}`}
          slug={target.id}
          rel={target.rel}
        />
      )
    case 'mcp':
      return <McpDetail key={target.name} name={target.name} />
    case 'env':
      return <EnvDetail key={target.keyId} keyId={target.keyId} />
    case 'create':
      return <CreatePane key={target.section} section={target.section} />
  }
}

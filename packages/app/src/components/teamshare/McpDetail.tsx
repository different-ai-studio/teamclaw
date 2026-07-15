import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Plug, RefreshCw, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useTeamShareBrowserStore, type TeamMcpItem } from '@/stores/team-share-browser'

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4 border-b border-border/60 py-2.5 last:border-b-0">
      <span className="w-28 shrink-0 text-[12.5px] text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words text-[13px] text-foreground">{children}</span>
    </div>
  )
}

function StatusBadge({ item }: { item: TeamMcpItem }) {
  const { t } = useTranslation()
  const map = {
    ready: { label: t('teamShare.mcpDetail.connected', 'Connected'), cls: 'bg-emerald-500/10 text-emerald-600' },
    failed: { label: t('teamShare.mcpDetail.failed', 'Needs attention'), cls: 'bg-amber-500/10 text-amber-600' },
    unknown: { label: t('teamShare.mcpDetail.idle', 'Idle'), cls: 'bg-muted text-muted-foreground' },
    skipped: { label: t('teamShare.mcpDetail.idle', 'Idle'), cls: 'bg-muted text-muted-foreground' },
  } as const
  const s = map[item.probeStatus]
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px] font-medium', s.cls)}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {s.label}
    </span>
  )
}

export function McpDetail({ name }: { name: string }) {
  const { t } = useTranslation()
  const item = useTeamShareBrowserStore((s) => s.mcp.items.find((x) => x.name === name))
  const loadMcpTools = useTeamShareBrowserStore((s) => s.loadMcpTools)
  const [refreshing, setRefreshing] = React.useState(false)

  const handleRefresh = React.useCallback(async () => {
    setRefreshing(true)
    try {
      await loadMcpTools({ refresh: true })
    } finally {
      setRefreshing(false)
    }
  }, [loadMcpTools])

  if (!item) return null
  const cfg = item.config
  const transport = cfg.type === 'remote' ? 'http' : cfg.type === 'local' ? 'stdio' : cfg.type ?? '—'
  const envKeys = Object.keys(cfg.environment ?? {})
  const headerKeys = Object.keys(cfg.headers ?? {})
  const { source: _source, type: _type, enabled: _enabled, command: _c, url: _u, environment: _e, headers: _h, timeout: _to, ...rest } = cfg
  void _source; void _type; void _enabled; void _c; void _u; void _e; void _h; void _to

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3" data-tauri-drag-region>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Plug className="h-[17px] w-[17px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-faint">{t('teamShare.mcpDetail.server', 'MCP Server')}</div>
          <div className="flex items-center gap-2">
            <span className="truncate text-[15px] font-bold text-foreground">{item.name}</span>
            <StatusBadge item={item} />
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => void handleRefresh()}
          disabled={refreshing}
          className="h-8 gap-1.5 text-[13px]"
        >
          {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {t('teamShare.mcpDetail.resync', 'Re-sync')}
        </Button>
      </div>

      <div className="space-y-6 px-6 py-5">
        <section>
          <h3 className="mb-1 text-[12px] font-medium uppercase tracking-wide text-faint">
            {t('teamShare.mcpDetail.connection', 'Connection')}
          </h3>
          <InfoRow label={t('teamShare.mcpDetail.transport', 'Transport')}>{transport}</InfoRow>
          {cfg.url && <InfoRow label={t('teamShare.mcpDetail.endpoint', 'Endpoint')}><span className="font-mono text-[12.5px]">{cfg.url}</span></InfoRow>}
          {cfg.command && cfg.command.length > 0 && (
            <InfoRow label={t('teamShare.mcpDetail.command', 'Command')}>
              <span className="font-mono text-[12.5px]">{cfg.command.join(' ')}</span>
            </InfoRow>
          )}
          <InfoRow label={t('teamShare.mcpDetail.scope', 'Scope')}>{t('teamShare.scope.team', 'Team')}</InfoRow>
          {envKeys.length > 0 && (
            <InfoRow label={t('teamShare.mcpDetail.env', 'Env')}>
              <span className="font-mono text-[12.5px]">{envKeys.join(', ')}</span>
            </InfoRow>
          )}
          {headerKeys.length > 0 && (
            <InfoRow label={t('teamShare.mcpDetail.headers', 'Headers')}>
              <span className="font-mono text-[12.5px]">{headerKeys.join(', ')}</span>
            </InfoRow>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-faint">
            {t('teamShare.mcpDetail.tools', 'Tools')} · {item.tools.length}
          </h3>
          {item.probeStatus === 'unknown' ? (
            <p className="text-[13px] text-muted-foreground">{t('teamShare.mcpDetail.probeHint', 'Re-sync to load tools.')}</p>
          ) : item.error ? (
            <p className="text-[13px] text-amber-600">{item.error}</p>
          ) : item.tools.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{t('teamShare.mcpDetail.noTools', 'No tools reported.')}</p>
          ) : (
            <div className="space-y-1.5">
              {item.tools.map((tool) => (
                <div key={tool} className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                  <span className="font-mono text-[12.5px] font-semibold text-foreground">{tool}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-faint">
            {t('teamShare.mcpDetail.config', 'Configuration')}
          </h3>
          <pre className="overflow-x-auto rounded-lg bg-neutral-900 px-4 py-3 text-[12px] leading-relaxed text-neutral-100">
            {JSON.stringify({ type: cfg.type, command: cfg.command, url: cfg.url, environment: cfg.environment, headers: cfg.headers, timeout: cfg.timeout, ...rest }, null, 2)}
          </pre>
        </section>
      </div>
    </div>
  )
}

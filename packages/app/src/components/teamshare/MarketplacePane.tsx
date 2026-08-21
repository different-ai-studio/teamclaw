import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Store, Search, Check, ArrowLeft, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useTeamShareBrowserStore } from '@/stores/team-share-browser'
import { getBackend } from '@/lib/backend/provider'
import {
  TEAM_SKILL_CATEGORIES,
  type TeamSkillCategory,
} from '@/lib/backend/cloud-api/team-skills'
import type {
  MarketplaceSkill,
  MarketplaceSkillDetail,
} from '@/lib/backend/cloud-api/marketplace'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

const CACHE_KEY = 'teamclu.marketplace.catalog.v1'

function readCache(): MarketplaceSkill[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeCache(items: MarketplaceSkill[]) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(items))
  } catch {
    /* ignore quota */
  }
}

export function MarketplacePane({ slug }: { slug?: string }) {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const openDetail = useTeamShareBrowserStore((s) => s.openDetail)
  const adoptMarketplaceSkill = useTeamShareBrowserStore((s) => s.adoptMarketplaceSkill)
  const loadSection = useTeamShareBrowserStore((s) => s.loadSection)

  const [items, setItems] = React.useState<MarketplaceSkill[]>(() => readCache())
  const [offline, setOffline] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [q, setQ] = React.useState('')
  const [category, setCategory] = React.useState<TeamSkillCategory | 'all'>('all')
  const [detail, setDetail] = React.useState<MarketplaceSkillDetail | null>(null)
  const [adopting, setAdopting] = React.useState(false)

  const reload = React.useCallback(async () => {
    setLoading(true)
    try {
      const backend = getBackend()
      const list = await backend.marketplace.listMarketplaceSkills({
        q: q.trim() || undefined,
        category: category === 'all' ? undefined : category,
        teamId: teamId ?? undefined,
      })
      setItems(list)
      writeCache(list)
      setOffline(false)
    } catch {
      setOffline(true)
      if (!items.length) setItems(readCache())
    } finally {
      setLoading(false)
    }
  }, [q, category, teamId, items.length])

  React.useEffect(() => {
    void reload()
  }, [reload])

  React.useEffect(() => {
    if (!slug) {
      setDetail(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const d = await getBackend().marketplace.getMarketplaceSkill(slug, {
          teamId: teamId ?? undefined,
        })
        if (!cancelled) setDetail(d)
      } catch {
        if (!cancelled) toast.error(t('teamShare.marketplaceLoadFailed', '无法加载市场详情'))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [slug, teamId, t])

  const onAdopt = async (marketplaceSlug: string) => {
    if (!teamId) return
    setAdopting(true)
    try {
      await adoptMarketplaceSkill(marketplaceSlug)
      toast.success(t('teamShare.marketplaceAdopted', '已引入团队'))
      await loadSection('skills')
      void reload()
      if (slug) {
        const d = await getBackend().marketplace.getMarketplaceSkill(slug, { teamId })
        setDetail(d)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setAdopting(false)
    }
  }

  if (slug && detail) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto">
        <div className="flex items-center gap-3 border-b border-border px-5 py-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => openDetail({ kind: 'marketplace' })}
            title={t('common.back', '返回')}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-bold text-foreground">
              {detail.displayName}{' '}
              <span className="font-mono text-[11px] font-normal text-faint">{detail.slug}</span>
            </div>
            <div className="text-[12px] text-muted-foreground">{detail.publisher}</div>
          </div>
          {detail.adoptedByTeam ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => openDetail({ kind: 'skill', id: detail.adoptedByTeam!.slug })}
            >
              {t('teamShare.marketplaceInTeam', '已在团队里')}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={adopting || !teamId}
              onClick={() => void onAdopt(detail.slug)}
            >
              {adopting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t('teamShare.marketplaceAdopt', '引入团队')}
            </Button>
          )}
        </div>

        <div className="space-y-4 px-6 py-5 text-[13.5px] leading-relaxed text-ink-2">
          <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-faint">
            <span>{detail.category}</span>
            <span>·</span>
            <span>
              {t('teamShare.marketplaceVersion', '市场')} v{detail.latestVersion}
            </span>
            {typeof detail.adoptCount === 'number' ? (
              <>
                <span>·</span>
                <span>
                  {t('teamShare.marketplaceAdoptCount', '已被 {{n}} 个团队引入', {
                    n: detail.adoptCount,
                  })}
                </span>
              </>
            ) : null}
          </div>
          <p className="text-foreground">{detail.summary}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">
                {t('teamShare.whenToUse', '何时使用')}
              </div>
              <p className="whitespace-pre-wrap">{detail.whenToUse || '—'}</p>
            </div>
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">
                {t('teamShare.whenNotToUse', '何时不要用')}
              </div>
              <p className="whitespace-pre-wrap">{detail.whenNotToUse || '—'}</p>
            </div>
          </div>
          {detail.requires ? (
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">
                {t('teamShare.requires', '依赖')}
              </div>
              <pre className="overflow-x-auto rounded-md bg-panel p-3 font-mono text-[12px]">
                {JSON.stringify(detail.requires, null, 2)}
              </pre>
            </div>
          ) : null}
          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">
              {t('teamShare.versions', '版本')}
            </div>
            <ul className="space-y-2">
              {detail.versions.map((v) => (
                <li key={v.version} className="rounded-md border border-border-soft bg-paper px-3 py-2">
                  <div className="font-mono text-[11px] text-faint">v{v.version}</div>
                  <div className="text-[12.5px] text-foreground">{v.changelog}</div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-panel text-muted-foreground">
          <Store className="h-[17px] w-[17px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-bold text-foreground">
            {t('teamShare.marketplaceTitle', 'Skills 市场')}
            {offline ? (
              <span className="ml-2 font-mono text-[10.5px] font-normal text-faint">
                {t('common.offline', '离线')}
              </span>
            ) : null}
          </div>
        </div>
        <div className="relative w-40">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-8 pl-7 text-[12.5px]"
            placeholder={t('common.search', '搜索')}
          />
        </div>
        <Select
          value={category}
          onValueChange={(v) => setCategory(v as TeamSkillCategory | 'all')}
        >
          <SelectTrigger className="h-8 w-32 text-[12px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('common.all', '全部')}</SelectItem>
            {TEAM_SKILL_CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {loading && !items.length ? (
          <div className="flex justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <div className="px-3 py-10 text-center text-[13px] text-muted-foreground">
            {t('teamShare.marketplaceEmpty', '目录为空')}
          </div>
        ) : (
          <ul className="space-y-1">
            {items.map((item) => (
              <li key={item.slug}>
                <button
                  type="button"
                  className={cn(
                    'flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-selected',
                  )}
                  onClick={() => openDetail({ kind: 'marketplace-item', slug: item.slug })}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold text-foreground">
                      {item.displayName}{' '}
                      <span className="font-mono text-[11px] font-normal text-faint">
                        {item.slug}
                      </span>
                    </div>
                    <div className="line-clamp-1 text-[12px] text-muted-foreground">
                      {item.summary}
                    </div>
                  </div>
                  <div className="shrink-0 pt-0.5" onClick={(e) => e.stopPropagation()}>
                    {item.adoptedByTeam ? (
                      <span className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground">
                        <Check className="h-3.5 w-3.5" />
                        {item.adoptedByTeam.upstreamSubscribed
                          ? t('teamShare.marketplaceFollowing', '团队 v{{tv}} · 跟随市场 v{{mv}}', {
                              tv: item.adoptedByTeam.latestVersion,
                              mv: item.latestVersion,
                            })
                          : t('teamShare.marketplaceDetached', '已断开')}
                      </span>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 text-[12px]"
                        disabled={adopting || !teamId}
                        onClick={() => void onAdopt(item.slug)}
                      >
                        {t('teamShare.marketplaceAdopt', '引入团队')}
                      </Button>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

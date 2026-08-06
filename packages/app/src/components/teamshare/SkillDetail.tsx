import * as React from 'react'
import { Suspense, lazy } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Sparkles,
  Save,
  Loader2,
  Download,
  Trash2,
  ArrowUpCircle,
  Archive,
  AlertTriangle,
  Share2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useWorkspaceStore } from '@/stores/workspace'
import { encodeWorkspaceId, putDaemonSkill } from '@/lib/daemon-local-client'
import { useTeamShareBrowserStore, type TeamSkillItem } from '@/stores/team-share-browser'
import { useCurrentTeamStore } from '@/stores/current-team'
import { getBackend } from '@/lib/backend/provider'
import {
  TEAM_SKILL_CATEGORIES,
  type TeamSkillCategory,
  type TeamSkillVersion,
} from '@/lib/backend/cloud-api/team-skills'
import { useIsDark } from './use-is-dark'

const CodeEditor = lazy(() => import('@/components/editors/CodeEditor'))

function UsageBoundary({ item }: { item: TeamSkillItem }) {
  const { t } = useTranslation()
  if (!item.whenToUse && !item.whenNotToUse) return null
  return (
    <div className="grid grid-cols-1 gap-3 border-b border-border px-5 py-4 sm:grid-cols-2">
      <section>
        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
          {t('teamShare.skillWhenToUse', 'When to use')}
        </h3>
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
          {item.whenToUse || t('teamShare.skillFieldEmpty', '—')}
        </p>
      </section>
      <section>
        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
          {t('teamShare.skillWhenNotToUse', 'When not to use')}
        </h3>
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
          {item.whenNotToUse || t('teamShare.skillFieldEmpty', '—')}
        </p>
      </section>
    </div>
  )
}

function formatShortDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function MetaRow({ item, ownerLabel }: { item: TeamSkillItem; ownerLabel: string | null }) {
  const { t } = useTranslation()
  const primary: string[] = []
  if (item.kind === 'personal' && item.personalSourceLabel) primary.push(item.personalSourceLabel)
  if (item.category) primary.push(item.category)
  if (item.latestVersion) primary.push(`v${item.latestVersion}`)
  if (item.installed && item.installedVersion && item.installedVersion !== item.latestVersion) {
    primary.push(t('teamShare.skillInstalledVersion', 'installed v{{v}}', { v: item.installedVersion }))
  }
  if (item.requires?.length) {
    primary.push(t('teamShare.skillRequires', 'requires {{list}}', { list: item.requires.join(', ') }))
  }

  const secondary: string[] = []
  if (ownerLabel) {
    secondary.push(t('teamShare.skillOwner', 'Owner · {{name}}', { name: ownerLabel }))
  }
  const updated = formatShortDate(item.updatedAt)
  if (updated) {
    secondary.push(t('teamShare.skillUpdated', 'Updated {{date}}', { date: updated }))
  }

  if (!primary.length && !secondary.length) return null
  return (
    <div className="space-y-1 border-b border-border px-5 py-2 text-[12px] text-muted-foreground">
      {primary.length > 0 && <div>{primary.join(' · ')}</div>}
      {secondary.length > 0 && <div className="text-[11px] text-faint">{secondary.join(' · ')}</div>}
    </div>
  )
}

function VersionHistory({
  versions,
  loading,
  installedVersion,
}: {
  versions: TeamSkillVersion[]
  loading: boolean
  installedVersion: number | null
}) {
  const { t } = useTranslation()
  if (loading) {
    return (
      <div className="flex items-center gap-2 border-b border-border px-5 py-3 text-[12px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('common.loading', 'Loading…')}
      </div>
    )
  }
  if (!versions.length) return null

  const sorted = [...versions].sort((a, b) => b.version - a.version)
  const latest = sorted[0]
  const older = sorted.slice(1, 4)

  return (
    <div className="border-b border-border px-5 py-4">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">
        {t('teamShare.skillVersions', 'Versions')}
      </h3>
      <div className="rounded-[8px] border border-border-soft bg-paper/60 px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-mono text-[12px] font-semibold text-foreground">
            v{latest.version}
            {installedVersion === latest.version && (
              <span className="ml-2 font-sans text-[10.5px] font-medium text-faint">
                {t('teamShare.skillInstalled', 'Installed')}
              </span>
            )}
          </span>
          <span className="shrink-0 font-mono text-[10.5px] text-faint">
            {formatShortDate(latest.createdAt) ?? ''}
          </span>
        </div>
        <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-2">
          {latest.changelog || t('teamShare.skillFieldEmpty', '—')}
        </p>
      </div>
      {older.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {older.map((v) => (
            <li key={v.version} className="flex gap-2 text-[11.5px] text-muted-foreground">
              <span className="shrink-0 font-mono text-faint">v{v.version}</span>
              <span className="min-w-0 truncate">{v.changelog || t('teamShare.skillFieldEmpty', '—')}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ShareSheet({
  item,
  open,
  onClose,
  onSubmit,
  busy,
}: {
  item: TeamSkillItem
  open: boolean
  onClose: () => void
  onSubmit: (input: {
    slug: string
    summary: string
    category: TeamSkillCategory
    whenToUse: string
    whenNotToUse: string
    changelog: string
  }) => Promise<void>
  busy: boolean
}) {
  const { t } = useTranslation()
  const [slug, setSlug] = React.useState(item.slug)
  const [summary, setSummary] = React.useState(item.summary ?? '')
  const [category, setCategory] = React.useState<TeamSkillCategory>(
    (TEAM_SKILL_CATEGORIES.includes(item.category as TeamSkillCategory)
      ? item.category
      : 'general') as TeamSkillCategory,
  )
  const [whenToUse, setWhenToUse] = React.useState(item.whenToUse ?? '')
  const [whenNotToUse, setWhenNotToUse] = React.useState(item.whenNotToUse ?? '')
  const [changelog, setChangelog] = React.useState('v1: shared from personal skill')

  React.useEffect(() => {
    if (!open) return
    setSlug(item.slug)
    setSummary(item.summary ?? '')
    setCategory(
      (TEAM_SKILL_CATEGORIES.includes(item.category as TeamSkillCategory)
        ? item.category
        : 'general') as TeamSkillCategory,
    )
    setWhenToUse(item.whenToUse ?? '')
    setWhenNotToUse(item.whenNotToUse ?? '')
    setChangelog('v1: shared from personal skill')
  }, [open, item])

  if (!open) return null

  const canSubmit =
    slug.trim() &&
    summary.trim() &&
    whenToUse.trim() &&
    whenNotToUse.trim() &&
    changelog.trim() &&
    !busy

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-[14px] border border-border bg-paper shadow-lg"
      >
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-[15px] font-bold text-foreground">
            {t('teamShare.skillShareTitle', 'Share to team')}
          </h2>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {t(
              'teamShare.skillShareHint',
              'Publishes a copy to the team registry and installs it for you. Your personal folder stays on disk.',
            )}
          </p>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <label className="block space-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">
              {t('teamShare.skillShareSlug', 'Slug')}
            </span>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              className="w-full rounded-[8px] border border-border bg-background px-3 py-2 font-mono text-[13px] outline-none focus:border-coral/60"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">
              {t('teamShare.skillShareSummary', 'Summary')}
            </span>
            <input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              maxLength={200}
              className="w-full rounded-[8px] border border-border bg-background px-3 py-2 text-[13px] outline-none focus:border-coral/60"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">
              {t('teamShare.skillShareCategory', 'Category')}
            </span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as TeamSkillCategory)}
              className="w-full rounded-[8px] border border-border bg-background px-3 py-2 text-[13px] outline-none focus:border-coral/60"
            >
              {TEAM_SKILL_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">
              {t('teamShare.skillWhenToUse', 'When to use')}
            </span>
            <textarea
              value={whenToUse}
              onChange={(e) => setWhenToUse(e.target.value)}
              rows={3}
              className="w-full rounded-[8px] border border-border bg-background px-3 py-2 text-[13px] outline-none focus:border-coral/60"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">
              {t('teamShare.skillWhenNotToUse', 'When not to use')}
            </span>
            <textarea
              value={whenNotToUse}
              onChange={(e) => setWhenNotToUse(e.target.value)}
              rows={3}
              className="w-full rounded-[8px] border border-border bg-background px-3 py-2 text-[13px] outline-none focus:border-coral/60"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">
              {t('teamShare.skillShareChangelog', 'Changelog')}
            </span>
            <textarea
              value={changelog}
              onChange={(e) => setChangelog(e.target.value)}
              rows={2}
              className="w-full rounded-[8px] border border-border bg-background px-3 py-2 text-[13px] outline-none focus:border-coral/60"
            />
          </label>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy} className="h-8 text-[13px]">
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            disabled={!canSubmit}
            onClick={() =>
              void onSubmit({
                slug: slug.trim(),
                summary: summary.trim(),
                category,
                whenToUse: whenToUse.trim(),
                whenNotToUse: whenNotToUse.trim(),
                changelog: changelog.trim(),
              })
            }
            className="h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Share2 className="h-3.5 w-3.5" />}
            {t('teamShare.skillShareSubmit', 'Share & install')}
          </Button>
        </div>
      </div>
    </div>
  )
}

export function SkillDetail({ slug }: { slug: string }) {
  const { t } = useTranslation()
  const isDark = useIsDark()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const item = useTeamShareBrowserStore((s) => s.skills.items.find((x) => x.slug === slug))
  const loadSection = useTeamShareBrowserStore((s) => s.loadSection)
  const installSkill = useTeamShareBrowserStore((s) => s.installSkill)
  const uninstallSkill = useTeamShareBrowserStore((s) => s.uninstallSkill)
  const sharePersonalSkill = useTeamShareBrowserStore((s) => s.sharePersonalSkill)
  const select = useTeamShareBrowserStore((s) => s.select)

  const [content, setContent] = React.useState(item?.content ?? '')
  const [saving, setSaving] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [shareOpen, setShareOpen] = React.useState(false)
  const [versions, setVersions] = React.useState<TeamSkillVersion[]>([])
  const [versionsLoading, setVersionsLoading] = React.useState(false)
  const [ownerLabel, setOwnerLabel] = React.useState<string | null>(null)
  const baseline = item?.content ?? ''

  React.useEffect(() => {
    setContent(item?.content ?? '')
  }, [slug, item?.content])

  React.useEffect(() => {
    if (!item || item.origin !== 'registry' || !teamId) {
      setVersions([])
      setOwnerLabel(null)
      return
    }
    let cancelled = false
    setVersionsLoading(true)
    void (async () => {
      try {
        const detail = await getBackend().teamSkills.getTeamSkill(teamId, item.slug)
        if (cancelled) return
        setVersions(detail.versions ?? [])
        const ownerId = detail.ownerActorId || item.ownerActorId
        if (ownerId) {
          try {
            const actors = await getBackend().actors.listActorDirectory(teamId)
            const match = actors.find((a) => a.id === ownerId)
            setOwnerLabel(match?.display_name?.trim() || ownerId.slice(0, 8))
          } catch {
            setOwnerLabel(ownerId.slice(0, 8))
          }
        } else {
          setOwnerLabel(null)
        }
      } catch {
        if (!cancelled) {
          setVersions([])
          setOwnerLabel(item.ownerActorId ? item.ownerActorId.slice(0, 8) : null)
        }
      } finally {
        if (!cancelled) setVersionsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [item, teamId, slug])

  const dirty = content !== baseline

  const handleSave = React.useCallback(async () => {
    if (!item || !workspacePath || saving) return
    setSaving(true)
    try {
      const saved = await putDaemonSkill(encodeWorkspaceId(workspacePath), item.slug, {
        content,
        dirPath: item.dirPath,
        filename: item.filename,
      })
      if (saved === null) throw new Error('daemon rejected the update')
      await loadSection('skills', { force: true })
    } catch (e) {
      toast.error(t('teamShare.saveFailed', 'Save failed: {{msg}}', { msg: e instanceof Error ? e.message : String(e) }))
    } finally {
      setSaving(false)
    }
  }, [item, workspacePath, saving, content, loadSection, t])

  const runInstall = React.useCallback(async () => {
    if (!item || busy) return
    setBusy(true)
    try {
      await installSkill(item.slug)
      toast.success(t('teamShare.skillInstalled', 'Installed'))
    } catch (e) {
      toast.error(
        t('teamShare.skillInstallFailed', 'Install failed: {{msg}}', {
          msg: e instanceof Error ? e.message : String(e),
        }),
      )
    } finally {
      setBusy(false)
    }
  }, [item, busy, installSkill, t])

  const runUninstall = React.useCallback(async () => {
    if (!item || busy) return
    setBusy(true)
    try {
      await uninstallSkill(item.slug)
      toast.success(t('teamShare.skillUninstalled', 'Uninstalled'))
    } catch (e) {
      toast.error(
        t('teamShare.skillUninstallFailed', 'Uninstall failed: {{msg}}', {
          msg: e instanceof Error ? e.message : String(e),
        }),
      )
    } finally {
      setBusy(false)
    }
  }, [item, busy, uninstallSkill, t])

  const runShare = React.useCallback(
    async (input: {
      slug: string
      summary: string
      category: TeamSkillCategory
      whenToUse: string
      whenNotToUse: string
      changelog: string
    }) => {
      if (!item || busy) return
      setBusy(true)
      try {
        await sharePersonalSkill(item.slug, input)
        setShareOpen(false)
        toast.success(t('teamShare.skillShareSuccess', 'Shared and installed'))
      } catch (e) {
        toast.error(
          t('teamShare.skillShareFailed', 'Share failed: {{msg}}', {
            msg: e instanceof Error ? e.message : String(e),
          }),
        )
      } finally {
        setBusy(false)
      }
    },
    [item, busy, sharePersonalSkill, t],
  )

  if (!item) return null

  const isRegistry = item.origin === 'registry'
  const isPersonal = item.kind === 'personal'
  const canEdit = Boolean(item.dirPath && item.filename && (item.kind === 'personal' || item.installed))
  const latestChangelog = [...versions].sort((a, b) => b.version - a.version)[0]?.changelog

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3" data-tauri-drag-region>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-coral/10 text-coral">
          <Sparkles className="h-[17px] w-[17px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-faint">
            {t('teamShare.skills', 'Skills')}
          </div>
          <div className="flex items-center gap-2">
            <span className="truncate text-[15px] font-bold text-foreground">{item.name}</span>
            {item.status === 'deprecated' && (
              <span className="flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                <Archive className="h-3 w-3" />
                {t('teamShare.skillDeprecated', 'Deprecated')}
              </span>
            )}
            {isPersonal && (
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {t('teamShare.skillPersonalBadge', 'Personal')}
              </span>
            )}
          </div>
        </div>
        <span className="shrink-0 font-mono text-[12px] text-muted-foreground">{item.invocationName}</span>

        {item.kind === 'team-available' && (
          <Button
            type="button"
            onClick={() => void runInstall()}
            disabled={busy || item.status === 'deprecated'}
            className={cn(
              'h-8 gap-1.5 text-[13px] font-semibold',
              item.status === 'deprecated'
                ? 'bg-muted text-muted-foreground hover:bg-muted/80'
                : 'bg-coral text-white hover:bg-coral/90',
            )}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {t('teamShare.skillInstall', 'Install')}
          </Button>
        )}

        {item.kind === 'team-installed' && (
          <>
            {item.hasUpdate && (
              <Button
                type="button"
                onClick={() => void runInstall()}
                disabled={busy}
                className="h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpCircle className="h-3.5 w-3.5" />}
                {t('teamShare.skillUpdate', 'Update')}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              onClick={() => void runUninstall()}
              disabled={busy}
              className="h-8 gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('teamShare.skillUninstall', 'Uninstall')}
            </Button>
          </>
        )}

        {isPersonal && (
          <Button
            type="button"
            onClick={() => setShareOpen(true)}
            disabled={busy}
            className="h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90"
          >
            <Share2 className="h-3.5 w-3.5" />
            {t('teamShare.skillShare', 'Share')}
          </Button>
        )}

        {canEdit && (
          <Button
            type="button"
            onClick={() => void handleSave()}
            disabled={!dirty || saving}
            className={cn(
              'h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90',
              !dirty && 'opacity-50',
            )}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {t('teamShare.save', 'Save')}
          </Button>
        )}
      </div>

      {item.status === 'deprecated' && item.supersededBy && (
        <button
          type="button"
          onClick={() => select('skills', item.supersededBy!)}
          className="flex w-full items-center gap-2 border-b border-border bg-muted/40 px-5 py-2 text-left text-[12px] text-muted-foreground hover:bg-muted/60"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {t('teamShare.skillSupersededBy', 'Deprecated — use {{slug}} instead', {
            slug: item.supersededBy,
          })}
        </button>
      )}

      {item.summary && (
        <div className="border-b border-border px-5 py-3 text-[13px] text-foreground">{item.summary}</div>
      )}
      <MetaRow item={item} ownerLabel={ownerLabel} />
      <UsageBoundary item={item} />
      {isRegistry && (
        <VersionHistory
          versions={versions}
          loading={versionsLoading}
          installedVersion={item.installedVersion}
        />
      )}

      <div className="min-h-0 flex-1">
        {canEdit ? (
          <Suspense
            fallback={
              <div className="p-6 text-[13px] text-muted-foreground">{t('common.loading', 'Loading…')}</div>
            }
          >
            <CodeEditor
              content={content}
              filename="SKILL.md"
              filePath={`${item.dirPath}/${item.filename}/SKILL.md`}
              onChange={setContent}
              isDark={isDark}
            />
          </Suspense>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <p className="max-w-sm text-[13px] leading-relaxed text-muted-foreground">
              {t(
                'teamShare.skillNotInstalledBody',
                'Install this skill to read and edit its package contents on disk.',
              )}
            </p>
            {latestChangelog && (
              <p className="max-w-md text-[12px] leading-relaxed text-faint">
                <span className="font-medium text-muted-foreground">
                  {t('teamShare.skillLatestChangelog', 'Latest changelog')}
                  {': '}
                </span>
                {latestChangelog}
              </p>
            )}
            {item.kind === 'team-available' && (
              <Button
                type="button"
                onClick={() => void runInstall()}
                disabled={busy || item.status === 'deprecated'}
                className="mt-1 h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90 disabled:opacity-40"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                {t('teamShare.skillInstall', 'Install')}
              </Button>
            )}
          </div>
        )}
      </div>

      {isPersonal && (
        <ShareSheet
          item={item}
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          onSubmit={runShare}
          busy={busy}
        />
      )}
    </div>
  )
}

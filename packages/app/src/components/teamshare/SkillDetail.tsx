import * as React from 'react'
import { Suspense, lazy } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles, Save, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useWorkspaceStore } from '@/stores/workspace'
import { encodeWorkspaceId, putDaemonSkill } from '@/lib/daemon-local-client'
import { useTeamShareBrowserStore } from '@/stores/team-share-browser'
import { useIsDark } from './use-is-dark'

const CodeEditor = lazy(() => import('@/components/editors/CodeEditor'))

export function SkillDetail({ slug }: { slug: string }) {
  const { t } = useTranslation()
  const isDark = useIsDark()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const item = useTeamShareBrowserStore((s) => s.skills.items.find((x) => x.slug === slug))
  const loadSection = useTeamShareBrowserStore((s) => s.loadSection)

  const [content, setContent] = React.useState(item?.content ?? '')
  const [saving, setSaving] = React.useState(false)
  const baseline = item?.content ?? ''

  React.useEffect(() => {
    setContent(item?.content ?? '')
  }, [slug, item?.content])

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
      toast.success(t('teamShare.saved', 'Saved'))
    } catch (e) {
      toast.error(t('teamShare.saveFailed', 'Save failed: {{msg}}', { msg: e instanceof Error ? e.message : String(e) }))
    } finally {
      setSaving(false)
    }
  }, [item, workspacePath, saving, content, loadSection, t])

  if (!item) return null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3" data-tauri-drag-region>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-coral/10 text-coral">
          <Sparkles className="h-[17px] w-[17px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-faint">{t('teamShare.skills', 'Skills')}</div>
          <div className="truncate text-[15px] font-bold text-foreground">{item.name}</div>
        </div>
        <span className="shrink-0 font-mono text-[12px] text-muted-foreground">{item.invocationName}</span>
        <Button
          type="button"
          onClick={() => void handleSave()}
          disabled={!dirty || saving}
          className={cn('h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90', !dirty && 'opacity-50')}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          {t('teamShare.save', 'Save')}
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <Suspense fallback={<div className="p-6 text-[13px] text-muted-foreground">{t('common.loading', 'Loading…')}</div>}>
          <CodeEditor
            content={content}
            filename="SKILL.md"
            filePath={`${item.dirPath}/${item.filename}/SKILL.md`}
            onChange={setContent}
            isDark={isDark}
          />
        </Suspense>
      </div>
    </div>
  )
}

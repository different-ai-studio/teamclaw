import * as React from 'react'
import { Suspense, lazy } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, Save, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useTeamShareBrowserStore } from '@/stores/team-share-browser'
import { useIsDark } from './use-is-dark'

const CodeEditor = lazy(() => import('@/components/editors/CodeEditor'))

export function KnowledgeDetail({ path }: { path: string }) {
  const { t } = useTranslation()
  const isDark = useIsDark()
  const item = useTeamShareBrowserStore((s) => s.knowledge.items.find((x) => x.path === path))

  const [content, setContent] = React.useState('')
  const [baseline, setBaseline] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const { readTextFile } = await import('@tauri-apps/plugin-fs')
        const text = await readTextFile(path)
        if (cancelled) return
        setContent(text)
        setBaseline(text)
      } catch (e) {
        if (cancelled) return
        toast.error(t('teamShare.readFailed', 'Could not read file: {{msg}}', { msg: e instanceof Error ? e.message : String(e) }))
        setContent('')
        setBaseline('')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [path, t])

  const dirty = content !== baseline

  const handleSave = React.useCallback(async () => {
    if (saving || loading) return
    setSaving(true)
    try {
      const { writeTextFile } = await import('@tauri-apps/plugin-fs')
      await writeTextFile(path, content)
      setBaseline(content)
      toast.success(t('teamShare.saved', 'Saved'))
    } catch (e) {
      toast.error(t('teamShare.saveFailed', 'Save failed: {{msg}}', { msg: e instanceof Error ? e.message : String(e) }))
    } finally {
      setSaving(false)
    }
  }, [saving, loading, path, content, t])

  if (!item) return null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3" data-tauri-drag-region>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-coral/10 text-coral">
          <FileText className="h-[17px] w-[17px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-faint">{t('teamShare.knowledge', 'Knowledge')}</div>
          <div className="truncate text-[15px] font-bold text-foreground">{item.name}</div>
        </div>
        <span className="shrink-0 truncate font-mono text-[11.5px] text-muted-foreground">{item.relPath}</span>
        <Button
          type="button"
          onClick={() => void handleSave()}
          disabled={!dirty || saving || loading}
          className={cn('h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90', !dirty && 'opacity-50')}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          {t('teamShare.save', 'Save')}
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center gap-2 p-6 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('common.loading', 'Loading…')}
          </div>
        ) : (
          <Suspense fallback={<div className="p-6 text-[13px] text-muted-foreground">{t('common.loading', 'Loading…')}</div>}>
            <CodeEditor content={content} filename={item.name} filePath={path} onChange={setContent} isDark={isDark} />
          </Suspense>
        )}
      </div>
    </div>
  )
}

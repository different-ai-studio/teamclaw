import { useTranslation } from 'react-i18next'
import { Box, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useUIStore } from '@/stores/ui'
import { useEnvVarsStore } from '@/stores/env-vars'

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4 border-b border-border/60 py-2.5 last:border-b-0">
      <span className="w-28 shrink-0 text-[12.5px] text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words text-[13px] text-foreground">{children}</span>
    </div>
  )
}

export function EnvDetail({ keyId }: { keyId: string }) {
  const { t } = useTranslation()
  const openSettings = useUIStore((s) => s.openSettings)
  const item = useEnvVarsStore((s) => s.teamSecrets.find((x) => x.keyId === keyId))

  if (!item) return null

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3" data-tauri-drag-region>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Box className="h-[17px] w-[17px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-faint">{t('teamShare.env', 'Team Env')}</div>
          <div className="truncate font-mono text-[15px] font-bold text-foreground">{item.keyId}</div>
        </div>
        <Button
          type="button"
          onClick={() => openSettings('envVars')}
          className="h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90"
        >
          <Pencil className="h-3.5 w-3.5" />
          {t('teamShare.edit', 'Edit')}
        </Button>
      </div>

      <div className="space-y-6 px-6 py-5">
        {item.description && <p className="text-[14px] leading-relaxed text-foreground">{item.description}</p>}

        <section>
          <div className="mb-1 text-[12px] font-medium uppercase tracking-wide text-faint">{t('teamShare.envDetail.value', 'Value')}</div>
          <div className="flex items-center justify-between rounded-lg border border-border bg-background px-4 py-3">
            <span className="font-mono text-[14px] tracking-widest text-muted-foreground">••••••••</span>
          </div>
          <p className="mt-1.5 text-[12px] text-muted-foreground">
            {t('teamShare.envDetail.encryptedHint', 'Team values are encrypted and not shown here. Use Edit to replace.')}
          </p>
        </section>

        <section>
          <h3 className="mb-1 text-[12px] font-medium uppercase tracking-wide text-faint">{t('teamShare.envDetail.details', 'Details')}</h3>
          <InfoRow label={t('teamShare.envDetail.key', 'Key')}><span className="font-mono text-[12.5px]">{item.keyId}</span></InfoRow>
          <InfoRow label={t('teamShare.envDetail.category', 'Category')}>{item.category || t('teamShare.envDetail.secret', 'Secret')}</InfoRow>
          <InfoRow label={t('teamShare.scope.label', 'Scope')}>{t('teamShare.scope.team', 'Team')}</InfoRow>
          <InfoRow label={t('teamShare.envDetail.createdBy', 'Created by')}>{item.createdBy || '—'}</InfoRow>
          <InfoRow label={t('teamShare.envDetail.updatedBy', 'Updated by')}>{item.updatedBy || '—'}</InfoRow>
          <InfoRow label={t('teamShare.envDetail.updatedAt', 'Updated at')}>{item.updatedAt || '—'}</InfoRow>
        </section>
      </div>
    </div>
  )
}

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { getFreshAccessToken } from '@/lib/auth/session-store'

interface Props {
  teamId: string
  workspacePath: string
  isOwner: boolean
}

interface LiteLlmSetupResult {
  aiGatewayEndpoint: string
  litellmKey: string
}

/**
 * Team LiteLLM setup panel (LLM settings).
 *
 * - Non-owner: read-only "团队 LiteLLM 未开通".
 * - Owner, not yet set up: "开通 LiteLLM" button → invokes `team_litellm_setup`.
 * - After success: shows "已开通: {endpoint}".
 */
export function TeamLiteLlmSection({ teamId, workspacePath, isOwner }: Props) {
  const { t } = useTranslation()
  const [endpoint, setEndpoint] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSetup = async () => {
    if (!teamId || !workspacePath) return
    setBusy(true)
    setError(null)
    try {
      const accessToken = await getFreshAccessToken()
      const result = await invoke<LiteLlmSetupResult>('team_litellm_setup', {
        teamId,
        workspacePath,
        accessToken,
      })
      setEndpoint(result.aiGatewayEndpoint)
    } catch (e) {
      setError(typeof e === 'string' ? e : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-xl border border-border-soft bg-panel p-4 space-y-3">
      <div>
        <h4 className="text-[13.5px] font-semibold">{t('settings.teamLlm.title')}</h4>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          {t('settings.teamLlm.description')}
        </p>
      </div>

      {endpoint ? (
        <p className="text-[12.5px]">
          {t('settings.teamLlm.enabledLabel')}
          <span className="ml-1 font-mono break-all">{endpoint}</span>
        </p>
      ) : isOwner ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12.5px] text-foreground">{t('settings.teamLlm.notEnabled')}</p>
          <Button size="sm" onClick={handleSetup} disabled={busy}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {t('settings.teamLlm.enableButton')}
          </Button>
        </div>
      ) : (
        <p className="text-[12.5px] text-muted-foreground">{t('settings.teamLlm.notEnabled')}</p>
      )}

      {error && <p className="text-[12px] text-red-500">{error}</p>}
    </section>
  )
}

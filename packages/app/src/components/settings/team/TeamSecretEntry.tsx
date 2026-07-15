import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Wand2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTeamShareStore } from '@/stores/team-share'

interface Props {
  teamId: string
  workspacePath: string
  onSaved?: () => void
  /**
   * Show a "Generate" button that fills a random 64-hex secret. Enabled for the
   * inviter-facing settings panels; left off for JoinTeamFlow, where the member
   * must paste the inviter's secret rather than mint a fresh, mismatched one.
   */
  allowGenerate?: boolean
}

const HEX64 = /^[0-9a-fA-F]{64}$/

/** Random 32-byte key rendered as 64 lowercase hex chars. */
export function randomSecretHex(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Resolve arbitrary user input to a 64-hex team secret:
 *   - already 64 hex → used verbatim (member pasting the inviter's secret)
 *   - any other non-empty passphrase → SHA-256 derived to 32 bytes / 64 hex
 * Deterministic, so members typing the same passphrase land on the same key.
 */
export async function resolveSecretHex(raw: string): Promise<string> {
  const trimmed = raw.trim()
  if (HEX64.test(trimmed)) return trimmed.toLowerCase()
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(trimmed))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Standalone team-secret input. Accepts either a 64-hex key or any passphrase
 * (derived client-side to 64 hex), then calls team_share_set_team_secret.
 *
 * Reused by JoinTeamFlow (Task 12) and by settings UIs for member
 * onboarding where the joiner must paste the secret from the inviter.
 */
export function TeamSecretEntry({ teamId, workspacePath, onSaved, allowGenerate }: Props) {
  const { t } = useTranslation()
  const setSecret = useTeamShareStore((s) => s.setSecret)
  const getSecret = useTeamShareStore((s) => s.getSecret)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedOk, setSavedOk] = useState(false)

  // Seed the field with the currently-saved secret so re-entering the panel
  // shows the configured value instead of a blank box. Only prefill while the
  // user hasn't typed anything (empty field) to avoid clobbering an in-progress
  // edit when teamId/workspacePath change.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const saved = await getSecret(teamId, workspacePath)
      if (cancelled || !saved) return
      setValue((cur) => (cur.trim().length === 0 ? saved : cur))
    })()
    return () => {
      cancelled = true
    }
  }, [teamId, workspacePath, getSecret])

  const trimmed = value.trim()
  const valid = trimmed.length > 0

  async function handleSave() {
    if (!valid) {
      setError(t('settings.teamSecret.emptyError'))
      return
    }
    setSaving(true)
    setError(null)
    setSavedOk(false)
    try {
      const secretHex = await resolveSecretHex(trimmed)
      await setSecret(teamId, secretHex, workspacePath)
      setSavedOk(true)
      onSaved?.()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2">
      <Label htmlFor="team-secret">{t('settings.teamSecret.label')}</Label>
      <Input
        id="team-secret"
        className="font-mono text-[12px]"
        placeholder={t('settings.teamSecret.placeholder')}
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          setError(null)
          setSavedOk(false)
        }}
      />
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={handleSave} disabled={saving || !valid}>
          {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          {t('common.save')}
        </Button>
        {allowGenerate && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setValue(randomSecretHex())
              setError(null)
              setSavedOk(false)
            }}
            disabled={saving}
          >
            <Wand2 className="mr-1.5 h-3.5 w-3.5" />
            {t('settings.teamSecret.generate')}
          </Button>
        )}
        {savedOk && (
          <span className="text-[12px] text-emerald-600">{t('settings.teamSecret.savedOk')}</span>
        )}
      </div>
      <p className="text-[11.5px] text-muted-foreground">{t('settings.teamSecret.hint')}</p>
      {error && <p className="text-[12px] text-red-500">{error}</p>}
    </div>
  )
}

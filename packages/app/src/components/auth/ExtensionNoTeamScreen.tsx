import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

function configuredMessage(
  messages: Record<string, string>,
  language: string | undefined,
): string | null {
  const locale = language?.trim() || 'zh-CN'
  const base = locale.split('-')[0]
  const candidates = [locale, base, base === 'zh' ? 'zh-CN' : null, 'zh-CN', 'en']
  for (const candidate of candidates) {
    if (!candidate) continue
    const message = messages[candidate]?.trim()
    if (message) return message
  }
  return null
}

export function ExtensionNoTeamScreen({
  messages,
  checking,
  onRetry,
  onSignOut,
}: {
  messages: Record<string, string>
  checking: boolean
  onRetry: () => void
  onSignOut: () => void
}) {
  const { t, i18n } = useTranslation()
  const message = configuredMessage(messages, i18n?.resolvedLanguage ?? i18n?.language)
    ?? t(
      'auth.extensionNoTeam.message',
      '当前账号尚未加入任何团队，请联系管理员向你的登录邮箱发送团队邀请。',
    )

  return (
    <div className="flex h-screen items-center justify-center bg-background px-6">
      <div className="w-full max-w-[440px] rounded-[16px] border border-border bg-paper p-6 shadow-sm">
        <h1 className="text-[16px] font-semibold text-foreground">
          {t('auth.extensionNoTeam.title', '暂未加入团队')}
        </h1>
        <p className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-5 text-muted-foreground">
          {message}
        </p>
        <div className="mt-5 flex flex-col gap-4">
          <Button
            className="h-10 w-full rounded-[10px] bg-coral text-coral-foreground hover:opacity-90"
            disabled={checking}
            onClick={onRetry}
          >
            {checking ? (
              <span className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('auth.extensionNoTeam.checking', '正在检查…')}
              </span>
            ) : (
              t('auth.extensionNoTeam.retry', '重新检查邀请')
            )}
          </Button>
          <button
            type="button"
            onClick={onSignOut}
            disabled={checking}
            className="text-[12px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            {t('auth.teamBootstrapError.signOut', '退出登录并使用其他账号')}
          </button>
        </div>
      </div>
    </div>
  )
}

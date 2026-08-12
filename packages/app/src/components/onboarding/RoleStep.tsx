import { useTranslation } from 'react-i18next'
import { Terminal, Sparkles, Languages } from 'lucide-react'

import { appDisplayName } from '@/lib/build-config'
import { changeLanguage, getCurrentLanguage, isLocaleLocked, availableLanguages } from '@/lib/i18n'
import { useAppVersion } from '@/lib/version'
import { useOnboardingStore, type OnboardingRole } from '@/stores/onboarding'
import { cn } from '@/lib/utils'

// Each language named in its own script: somebody scanning for a language they
// can read recognizes "中文" and "English", not the ISO code "EN".
const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English',
  'zh-CN': '中文',
}

/**
 * Locale toggle. Hidden entirely on single-locale builds.
 *
 * Centered and full-size rather than tucked into a corner: it is the one control
 * on this screen a user might need *before* they can read anything else on it,
 * so it cannot be the quietest thing in the frame.
 */
function LanguageToggle() {
  const current = getCurrentLanguage()
  if (isLocaleLocked || availableLanguages.length < 2) return null
  return (
    <div className="flex items-center gap-2">
      <Languages className="h-4 w-4 shrink-0 text-faint" aria-hidden />
      <div className="flex items-center gap-1 rounded-[10px] bg-panel p-1">
        {availableLanguages.map((lang) => (
          <button
            key={lang}
            type="button"
            onClick={() => changeLanguage(lang)}
            aria-pressed={lang === current}
            className={cn(
              'rounded-[8px] px-4 py-1.5 text-[13px] font-medium transition-colors',
              lang === current
                ? 'bg-paper text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {LANGUAGE_LABELS[lang] ?? lang}
          </button>
        ))}
      </div>
    </div>
  )
}

function RoleCard({
  icon,
  title,
  caption,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  caption: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-1 flex-col items-start gap-3 rounded-[16px] border border-border bg-paper p-5 text-left transition-colors hover:bg-selected/45"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-panel text-ink-2 transition-colors group-hover:bg-coral group-hover:text-coral-foreground">
        {icon}
      </span>
      <span className="text-[14px] font-semibold text-foreground">{title}</span>
      <span className="text-[12.5px] leading-5 text-muted-foreground">{caption}</span>
    </button>
  )
}

/**
 * First screen of first-run setup (#881): pick how much of the setup you want
 * to drive. Everything after this branches on the answer — which runtimes are
 * offered, whether git is checked, whether we walk you through a model.
 */
export function RoleStep({ onDone }: { onDone: (role: OnboardingRole) => void }) {
  const { t } = useTranslation()
  const appVersion = useAppVersion()
  const setRole = useOnboardingStore((s) => s.setRole)

  const choose = (role: OnboardingRole) => {
    setRole(role)
    onDone(role)
  }

  return (
    <div className="relative flex min-h-screen flex-col bg-background px-6 py-8" data-tauri-drag-region>
      <div className="absolute inset-x-0 top-0 h-12" data-tauri-drag-region />
      <div className="mx-auto flex w-full max-w-[640px] flex-1 flex-col">
        <div className="flex justify-center pt-1">
          <LanguageToggle />
        </div>

        <div className="flex flex-1 flex-col justify-center">
          <div className="mb-7 text-center">
            <img
              src="/logo.png"
              alt={`${appDisplayName} logo`}
              className="mx-auto mb-4 h-16 w-16 object-contain"
            />
            <h1 className="text-[22px] font-semibold text-foreground">
              {t('onboarding.role.title', 'How would you like to set up {{app}}?', {
                app: appDisplayName,
              })}
            </h1>
            <p className="mx-auto mt-2 max-w-sm text-[13px] leading-6 text-muted-foreground">
              {t('onboarding.role.subtitle', 'You can change any of this later in Settings.')}
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <RoleCard
              icon={<Terminal className="h-5 w-5" />}
              title={t('onboarding.role.developerTitle', "I'll set it up myself")}
              caption={t(
                'onboarding.role.developerCaption',
                'Choose the agent runtime and review what gets installed.',
              )}
              onClick={() => choose('developer')}
            />
            <RoleCard
              icon={<Sparkles className="h-5 w-5" />}
              title={t('onboarding.role.guidedTitle', 'Just get me started')}
              caption={t(
                'onboarding.role.guidedCaption',
                'Use the recommended setup and connect a model in one step.',
              )}
              onClick={() => choose('guided')}
            />
          </div>
        </div>

        <p className="mt-6 text-center font-mono text-[11px] text-faint">v{appVersion}</p>
      </div>
    </div>
  )
}

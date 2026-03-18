import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { MessageSquareText, Sparkles, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingCard, SectionHeader } from './shared'
import { toast } from 'sonner'

const STORAGE_KEY = 'teamclaw-system-prompt'

function loadSystemPrompt(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored || ''
  } catch {
    return ''
  }
}

function saveSystemPrompt(prompt: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, prompt)
  } catch (error) {
    console.error('Failed to save system prompt:', error)
    throw error
  }
}

export const PromptSection = React.memo(function PromptSection() {
  const { t } = useTranslation()
  const [systemPrompt, setSystemPrompt] = React.useState(() => loadSystemPrompt())

  const handleSave = React.useCallback(() => {
    try {
      saveSystemPrompt(systemPrompt)
      toast.success(
        t('settings.prompt.saveSuccess', 'System prompt saved successfully'),
        { duration: 2000 }
      )
    } catch (error) {
      toast.error(
        t('settings.prompt.saveError', 'Failed to save system prompt'),
        { duration: 3000 }
      )
    }
  }, [systemPrompt, t])

  return (
    <div className="space-y-6">
      <SectionHeader 
        icon={MessageSquareText} 
        title={t('settings.prompt.title', 'Prompt')} 
        description={t('settings.prompt.description', 'Customize the system prompt and conversation behavior')}
        iconColor="text-green-500"
      />
      
      <SettingCard>
        <div className="space-y-4">
          <label className="text-sm font-medium flex items-center gap-2">
            <MessageSquareText className="h-4 w-4 text-muted-foreground" />
            {t('settings.prompt.systemPrompt', 'System Prompt')}
          </label>
          <textarea
            className="flex min-h-[200px] w-full rounded-xl border border-input bg-background px-4 py-3 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder={t('settings.prompt.systemPromptPlaceholder', 'You are a helpful AI assistant that specializes in...')}
          />
          <p className="text-xs text-muted-foreground">
            {t('settings.prompt.systemPromptHint', "This prompt will be prepended to all conversations to guide the AI's behavior.")}
          </p>
        </div>
      </SettingCard>

      <SettingCard className="bg-gradient-to-br from-green-50 to-emerald-50 dark:from-green-950/30 dark:to-emerald-950/30 border-green-200 dark:border-green-800">
        <div className="flex items-start gap-3">
          <Sparkles className="h-5 w-5 text-green-600 dark:text-green-400 mt-0.5" />
          <div>
            <p className="font-medium text-green-900 dark:text-green-100">{t('settings.prompt.proTip', 'Pro Tip')}</p>
            <p className="text-sm text-green-700 dark:text-green-300 mt-1">
              {t('settings.prompt.proTipDesc', 'A good system prompt includes your preferred response style, any domain expertise needed, and specific guidelines for the AI to follow.')}
            </p>
          </div>
        </div>
      </SettingCard>

      <Button className="w-full h-11 gap-2" onClick={handleSave}>
        <Save className="h-4 w-4" />
        {t('settings.prompt.saveChanges', 'Save Changes')}
      </Button>
    </div>
  )
})

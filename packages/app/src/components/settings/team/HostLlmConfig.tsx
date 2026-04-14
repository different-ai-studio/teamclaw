import React from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Plus, X } from 'lucide-react'

export interface LlmModelEntry {
  id: string
  name: string
}

export interface HostLlmConfigProps {
  enabled: boolean
  onEnabledChange: (enabled: boolean) => void
  baseUrl: string
  onBaseUrlChange: (url: string) => void
  models: LlmModelEntry[]
  onModelsChange: (models: LlmModelEntry[]) => void
  disabled?: boolean
}

export const HostLlmConfig = React.memo(function HostLlmConfig({
  enabled,
  onEnabledChange,
  baseUrl,
  onBaseUrlChange,
  models,
  onModelsChange,
  disabled,
}: HostLlmConfigProps) {
  const { t } = useTranslation()

  const addModel = () => {
    onModelsChange([...models, { id: '', name: '' }])
  }

  const removeModel = (index: number) => {
    onModelsChange(models.filter((_, i) => i !== index))
  }

  const updateModel = (index: number, field: 'id' | 'name', value: string) => {
    const updated = models.map((m, i) => (i === index ? { ...m, [field]: value } : m))
    onModelsChange(updated)
  }

  return (
    <div className="rounded-lg border border-border/40 bg-muted/20 p-3 space-y-2">
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onEnabledChange(e.target.checked)}
          className="rounded border-border"
          disabled={disabled}
        />
        <span className="text-xs font-medium text-muted-foreground">
          {t('settings.team.hostLlm', 'Host LLM (team shared AI model)')}
        </span>
      </label>
      {enabled && (
        <div className="space-y-2 pt-1">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">LLM API {t('settings.team.llmBaseUrlLabel', 'Base URL')}</label>
            <Input
              value={baseUrl}
              onChange={(e) => onBaseUrlChange(e.target.value)}
              placeholder="https://your-llm-proxy.com/v1"
              className="bg-background/50 font-mono text-xs"
              disabled={disabled}
            />
          </div>

          {/* Models list */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs text-muted-foreground">{t('settings.team.llmModels', 'Models')}</label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-xs text-muted-foreground"
                onClick={addModel}
                disabled={disabled}
              >
                <Plus className="h-3 w-3 mr-0.5" />
                {t('settings.team.addModel', 'Add')}
              </Button>
            </div>
            {models.map((model, index) => (
              <div key={index} className="flex items-center gap-1.5">
                <Input
                  value={model.id}
                  onChange={(e) => updateModel(index, 'id', e.target.value)}
                  placeholder="model-id"
                  className="bg-background/50 font-mono text-xs flex-1"
                  disabled={disabled}
                />
                <Input
                  value={model.name}
                  onChange={(e) => updateModel(index, 'name', e.target.value)}
                  placeholder={t('settings.team.modelNamePlaceholder', 'Display name')}
                  className="bg-background/50 text-xs flex-1"
                  disabled={disabled}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive shrink-0"
                  onClick={() => removeModel(index)}
                  disabled={disabled}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>

          <p className="text-xs text-muted-foreground/60">
            {t('settings.team.llmApiKeyHint', 'API key is read from env var')} <code className="rounded bg-muted px-1 py-0.5 font-mono">tc_api_key</code>{t('settings.team.llmApiKeyDefault', ', defaults to device ID')}
          </p>
        </div>
      )}
    </div>
  )
})

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Save, Sparkles, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingCard } from './shared'
import { useKnowledgeStore, type RagConfig } from '@/stores/knowledge'
import { isTauri } from '@/lib/utils'

/** Reusable form row: label + description on left, control on right */
function FormRow({ children, label, description }: {
  children: React.ReactNode
  label: string
  description?: string
}) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="space-y-0.5 min-w-0">
        <Label className="text-sm">{label}</Label>
        {description && (
          <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/** Reusable stacked form field: label on top, input below */
function FormField({ children, label, description, htmlFor }: {
  children: React.ReactNode
  label: string
  description?: string
  htmlFor?: string
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor} className="text-sm">{label}</Label>
      {children}
      {description && (
        <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
      )}
    </div>
  )
}

export const KnowledgeConfigPanel = React.memo(function KnowledgeConfigPanel() {
  const { t } = useTranslation()
  const { config, isLoadingConfig, loadConfig, saveConfig } = useKnowledgeStore()

  const [localConfig, setLocalConfig] = React.useState<RagConfig | null>(null)
  const [isSaving, setIsSaving] = React.useState(false)

  React.useEffect(() => {
    if (isTauri()) {
      loadConfig()
    }
  }, [loadConfig])

  React.useEffect(() => {
    if (config) {
      setLocalConfig(config)
    }
  }, [config])

  const handleSave = React.useCallback(async () => {
    if (!localConfig) return

    setIsSaving(true)
    try {
      await saveConfig(localConfig)
    } finally {
      setIsSaving(false)
    }
  }, [localConfig, saveConfig])

  const updateConfig = React.useCallback((updates: Partial<RagConfig>) => {
    setLocalConfig((prev) => (prev ? { ...prev, ...updates } : null))
  }, [])

  if (isLoadingConfig || !localConfig) {
    return (
      <SettingCard>
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </SettingCard>
    )
  }

  return (
    <SettingCard>
      <Tabs defaultValue="auto-inject" className="space-y-5">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="auto-inject" className="flex items-center gap-1.5 text-xs">
            <Sparkles className="h-3.5 w-3.5" />
            {t('settings.knowledge.config.tabs.autoInject', 'Auto Inject')}
          </TabsTrigger>
          <TabsTrigger value="embedding" className="text-xs">
            {t('settings.knowledge.config.tabs.embedding', 'Embedding')}
          </TabsTrigger>
          <TabsTrigger value="search" className="text-xs">
            {t('settings.knowledge.config.tabs.search', 'Search')}
          </TabsTrigger>
          <TabsTrigger value="advanced" className="text-xs">
            {t('settings.knowledge.config.tabs.advanced', 'Advanced')}
          </TabsTrigger>
        </TabsList>

        {/* ── Auto-Inject ── */}
        <TabsContent value="auto-inject" className="space-y-4">
          <div className="rounded-lg bg-gradient-to-br from-purple-50 to-indigo-50 dark:from-purple-950/30 dark:to-indigo-950/30 border border-purple-200/60 dark:border-purple-800/60 p-4">
            <div className="flex items-start gap-3">
              <Sparkles className="h-5 w-5 text-purple-500 dark:text-purple-400 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium text-sm text-purple-900 dark:text-purple-100">
                  {t('settings.knowledge.config.autoInject.banner', 'RAG V2: Pre-inference Auto Inject')}
                </p>
                <p className="text-xs text-purple-700 dark:text-purple-300 mt-1 leading-relaxed">
                  {t('settings.knowledge.config.autoInject.bannerDesc')}
                </p>
              </div>
            </div>
          </div>

          <FormRow
            label={t('settings.knowledge.config.autoInject.enable', 'Enable Auto Inject')}
            description={t('settings.knowledge.config.autoInject.enableDesc')}
          >
            <Switch
              checked={localConfig.autoInjectEnabled}
              onCheckedChange={(checked) => updateConfig({ autoInjectEnabled: checked })}
            />
          </FormRow>

          {localConfig.autoInjectEnabled && (
            <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
              <div className="grid grid-cols-3 gap-4">
                <FormField
                  label={t('settings.knowledge.config.autoInject.threshold', 'Similarity Threshold')}
                  htmlFor="auto-inject-threshold"
                >
                  <Input
                    id="auto-inject-threshold"
                    type="number"
                    step="0.05"
                    min="0"
                    max="1"
                    value={localConfig.autoInjectThreshold}
                    onChange={(e) => updateConfig({ autoInjectThreshold: parseFloat(e.target.value) || 0.4 })}
                  />
                </FormField>

                <FormField label="Top K" htmlFor="auto-inject-top-k">
                  <Input
                    id="auto-inject-top-k"
                    type="number"
                    min="1"
                    max="10"
                    value={localConfig.autoInjectTopK}
                    onChange={(e) => updateConfig({ autoInjectTopK: parseInt(e.target.value) || 3 })}
                  />
                </FormField>

                <FormField
                  label={t('settings.knowledge.config.autoInject.maxTokens', 'Token Limit')}
                  htmlFor="auto-inject-max-tokens"
                >
                  <Input
                    id="auto-inject-max-tokens"
                    type="number"
                    step="100"
                    min="500"
                    max="8000"
                    value={localConfig.autoInjectMaxTokens}
                    onChange={(e) => updateConfig({ autoInjectMaxTokens: parseInt(e.target.value) || 2000 })}
                  />
                </FormField>
              </div>

              <p className="text-xs text-muted-foreground leading-relaxed">
                {t('settings.knowledge.config.autoInject.thresholdDesc')}
              </p>

              <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground space-y-1">
                <p className="font-medium">{t('settings.knowledge.config.autoInject.tipsTitle', 'Tips:')}</p>
                <ul className="list-disc list-inside space-y-0.5 ml-1">
                  <li>{t('settings.knowledge.config.autoInject.tip1')}</li>
                  <li>{t('settings.knowledge.config.autoInject.tip2')}</li>
                  <li>{t('settings.knowledge.config.autoInject.tip3')}</li>
                  <li>{t('settings.knowledge.config.autoInject.tip4')}</li>
                </ul>
              </div>
            </div>
          )}
        </TabsContent>

        {/* ── Embedding ── */}
        <TabsContent value="embedding" className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <FormField
              label={t('settings.knowledge.config.embedding.provider', 'Provider')}
              htmlFor="embedding-provider"
            >
              <Select
                value={localConfig.embeddingProvider}
                onValueChange={(value) => updateConfig({ embeddingProvider: value })}
              >
                <SelectTrigger id="embedding-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI Compatible</SelectItem>
                </SelectContent>
              </Select>
            </FormField>

            <FormField
              label={t('settings.knowledge.config.embedding.model', 'Model')}
              htmlFor="embedding-model"
            >
              <Input
                id="embedding-model"
                value={localConfig.embeddingModel}
                onChange={(e) => updateConfig({ embeddingModel: e.target.value })}
                placeholder="text-embedding-3-large"
              />
            </FormField>
          </div>

          <FormField label="Base URL" htmlFor="embedding-base-url">
            <Input
              id="embedding-base-url"
              value={localConfig.embeddingBaseUrl}
              onChange={(e) => updateConfig({ embeddingBaseUrl: e.target.value })}
              placeholder="https://api.openai.com/v1"
            />
          </FormField>

          <div className="grid grid-cols-2 gap-4">
            <FormField label="API Key" htmlFor="embedding-api-key">
              <Input
                id="embedding-api-key"
                type="password"
                value={localConfig.embeddingApiKey || ''}
                onChange={(e) => updateConfig({ embeddingApiKey: e.target.value || undefined })}
                placeholder="sk-..."
              />
            </FormField>

            <FormField
              label={t('settings.knowledge.config.embedding.dimensions', 'Vector Dimensions')}
              htmlFor="embedding-dimensions"
            >
              <Input
                id="embedding-dimensions"
                type="number"
                value={localConfig.embeddingDimensions}
                onChange={(e) => updateConfig({ embeddingDimensions: parseInt(e.target.value) || 2560 })}
                placeholder="2560"
              />
            </FormField>
          </div>
        </TabsContent>

        {/* ── Search ── */}
        <TabsContent value="search" className="space-y-4">
          <FormField
            label={t('settings.knowledge.config.search.hybridWeight', 'Hybrid Search Weight')}
            description={t('settings.knowledge.config.search.hybridWeightDesc')}
            htmlFor="hybrid-weight"
          >
            <div className="flex items-center gap-3">
              <Input
                id="hybrid-weight"
                type="number"
                step="0.1"
                min="0"
                max="1"
                value={localConfig.hybridWeight}
                onChange={(e) => updateConfig({ hybridWeight: parseFloat(e.target.value) || 0.7 })}
                className="w-24"
              />
              <span className="text-xs text-muted-foreground tabular-nums">
                {localConfig.hybridWeight.toFixed(1)} {t('settings.knowledge.config.search.semantic', 'Semantic')} / {(1 - localConfig.hybridWeight).toFixed(1)} BM25
              </span>
            </div>
          </FormField>

          <div className="grid grid-cols-2 gap-4">
            <FormField
              label={t('settings.knowledge.config.search.chunkSize', 'Chunk Size')}
              description={t('settings.knowledge.config.search.chunkSizeDesc')}
              htmlFor="chunk-size"
            >
              <Input
                id="chunk-size"
                type="number"
                value={localConfig.chunkSize}
                onChange={(e) => updateConfig({ chunkSize: parseInt(e.target.value) || 800 })}
                placeholder="800"
              />
            </FormField>

            <FormField
              label={t('settings.knowledge.config.search.chunkOverlap', 'Chunk Overlap')}
              description={t('settings.knowledge.config.search.chunkOverlapDesc')}
              htmlFor="chunk-overlap"
            >
              <Input
                id="chunk-overlap"
                type="number"
                value={localConfig.chunkOverlap}
                onChange={(e) => updateConfig({ chunkOverlap: parseInt(e.target.value) || 100 })}
                placeholder="100"
              />
            </FormField>
          </div>
        </TabsContent>

        {/* ── Advanced ── */}
        <TabsContent value="advanced" className="space-y-4">
          <FormRow
            label={t('settings.knowledge.config.advanced.autoIndex', 'Auto Index')}
            description={t('settings.knowledge.config.advanced.autoIndexDesc')}
          >
            <Switch
              checked={localConfig.autoIndex}
              onCheckedChange={(checked) => updateConfig({ autoIndex: checked })}
            />
          </FormRow>

          <FormRow
            label={t('settings.knowledge.config.advanced.fileWatcher', 'File Watcher')}
            description={t('settings.knowledge.config.advanced.fileWatcherDesc')}
          >
            <Switch
              checked={localConfig.fileWatcherEnabled}
              onCheckedChange={(checked) => updateConfig({ fileWatcherEnabled: checked })}
            />
          </FormRow>

          <div className="border-t pt-4 space-y-4">
            <FormRow
              label={t('settings.knowledge.config.advanced.rerankEnabled', 'Enable Reranking')}
              description={t('settings.knowledge.config.advanced.rerankEnabledDesc')}
            >
              <Switch
                checked={localConfig.rerankEnabled}
                onCheckedChange={(checked) => updateConfig({ rerankEnabled: checked })}
              />
            </FormRow>

            {localConfig.rerankEnabled && (
              <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    label={t('settings.knowledge.config.advanced.rerankProvider', 'Rerank Provider')}
                    htmlFor="rerank-provider"
                  >
                    <Select
                      value={localConfig.rerankProvider}
                      onValueChange={(value) => updateConfig({ rerankProvider: value })}
                    >
                      <SelectTrigger id="rerank-provider">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="compass">Compass</SelectItem>
                        <SelectItem value="langsearch">LangSearch</SelectItem>
                        <SelectItem value="jina">Jina AI</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormField>

                  {localConfig.rerankProvider !== 'compass' && (
                    <FormField
                      label={t('settings.knowledge.config.advanced.rerankModel', 'Rerank Model')}
                      htmlFor="rerank-model"
                    >
                      <Input
                        id="rerank-model"
                        value={localConfig.rerankModel}
                        onChange={(e) => updateConfig({ rerankModel: e.target.value })}
                        placeholder={localConfig.rerankProvider === 'langsearch' ? 'langsearch-reranker-v1' : 'jina-reranker-v2-base-multilingual'}
                      />
                    </FormField>
                  )}
                </div>

                {localConfig.rerankProvider !== 'jina' && (
                  <FormField label="Rerank Base URL" htmlFor="rerank-base-url">
                    <Input
                      id="rerank-base-url"
                      value={localConfig.rerankBaseUrl}
                      onChange={(e) => updateConfig({ rerankBaseUrl: e.target.value })}
                      placeholder={localConfig.rerankProvider === 'compass' ? '' : 'https://api.langsearch.com/v1'}
                    />
                  </FormField>
                )}

                <div className="grid grid-cols-2 gap-4">
                  <FormField label="Rerank API Key" htmlFor="rerank-api-key">
                    <Input
                      id="rerank-api-key"
                      type="password"
                      value={localConfig.rerankApiKey || ''}
                      onChange={(e) => updateConfig({ rerankApiKey: e.target.value || undefined })}
                      placeholder="API Key"
                    />
                  </FormField>

                  <FormField
                    label="Rerank Top K"
                    description={t('settings.knowledge.config.advanced.rerankTopKDesc')}
                    htmlFor="rerank-top-k"
                  >
                    <Input
                      id="rerank-top-k"
                      type="number"
                      value={localConfig.rerankTopK}
                      onChange={(e) => updateConfig({ rerankTopK: parseInt(e.target.value) || 20 })}
                      placeholder="20"
                    />
                  </FormField>
                </div>
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* Save / Reset */}
      <div className="flex justify-end gap-2 pt-4 border-t mt-5">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setLocalConfig(config)}
          disabled={!config}
          className="gap-1.5"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t('settings.knowledge.config.reset', 'Reset')}
        </Button>
        <Button size="sm" onClick={handleSave} disabled={isSaving} className="gap-1.5">
          {isSaving ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('settings.knowledge.config.saving', 'Saving...')}
            </>
          ) : (
            <>
              <Save className="h-3.5 w-3.5" />
              {t('settings.knowledge.config.save', 'Save Configuration')}
            </>
          )}
        </Button>
      </div>
    </SettingCard>
  )
})

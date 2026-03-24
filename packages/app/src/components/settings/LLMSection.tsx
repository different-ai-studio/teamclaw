import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Brain,
  Plug,
  Loader2,
  Key,
  Shield,
  Plus,
  CircleDot,
  RefreshCw,
  Link,
  Trash2,
  ChevronRight,
  Zap,
  Settings,
} from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { useProviderStore } from '@/stores/provider'
import { useWorkspaceStore } from '@/stores/workspace'
import { useTeamModeStore } from '@/stores/team-mode'
import { initOpenCodeClient } from '@/lib/opencode/client'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SettingCard, SectionHeader } from './shared'

export const LLMSection = React.memo(function LLMSection() {
  const { t } = useTranslation()
  const teamMode = useTeamModeStore((s) => s.teamMode)
  const teamModelConfig = useTeamModeStore((s) => s.teamModelConfig)
  const devUnlocked = useTeamModeStore((s) => s.devUnlocked)
  const providers = useProviderStore((s) => s.providers)
  const providersLoading = useProviderStore((s) => s.providersLoading)
  const configuredProviders = useProviderStore((s) => s.configuredProviders)
  const refreshProviders = useProviderStore((s) => s.refreshProviders)
  const refreshConfiguredProviders = useProviderStore((s) => s.refreshConfiguredProviders)
  const connectProvider = useProviderStore((s) => s.connectProvider)
  const initAll = useProviderStore((s) => s.initAll)
  const customProviderIds = useProviderStore((s) => s.customProviderIds)
  const refreshCustomProviderIds = useProviderStore((s) => s.refreshCustomProviderIds)
  const addCustomProvider = useProviderStore((s) => s.addCustomProvider)
  const updateCustomProvider = useProviderStore((s) => s.updateCustomProvider)
  const getCustomProvider = useProviderStore((s) => s.getCustomProvider)
  const removeCustomProvider = useProviderStore((s) => s.removeCustomProvider)
  const disconnectProvider = useProviderStore((s) => s.disconnectProvider)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)

  // Dialog state for connecting a provider
  const [connectDialogOpen, setConnectDialogOpen] = React.useState(false)
  const [connectingProviderId, setConnectingProviderId] = React.useState<string>('')
  const [connectingProviderName, setConnectingProviderName] = React.useState<string>('')
  const [apiKeyInput, setApiKeyInput] = React.useState('')
  const [isConnecting, setIsConnecting] = React.useState(false)

  // Custom provider dialog state
  const [customDialogOpen, setCustomDialogOpen] = React.useState(false)
  const [editingProviderId, setEditingProviderId] = React.useState<string | null>(null)
  const [customName, setCustomName] = React.useState('')
  const [customBaseURL, setCustomBaseURL] = React.useState('')
  const [customApiKey, setCustomApiKey] = React.useState('')
  const [customModels, setCustomModels] = React.useState<Array<{
    modelId: string
    modelName: string
    contextLimit: string
    outputLimit: string
  }>>([{ modelId: '', modelName: '', contextLimit: '', outputLimit: '' }])
  const [isAddingCustom, setIsAddingCustom] = React.useState(false)

  // Delete confirmation state
  const [deletingProviderId, setDeletingProviderId] = React.useState<string | null>(null)
  const [isDeleting, setIsDeleting] = React.useState(false)

  // Disconnect confirmation state
  const [disconnectingProviderId, setDisconnectingProviderId] = React.useState<string | null>(null)
  const [disconnectingProviderName, setDisconnectingProviderName] = React.useState<string>('')
  const [isDisconnecting, setIsDisconnecting] = React.useState(false)

  // Detail view for connected provider
  const [selectedProviderId, setSelectedProviderId] = React.useState<string | null>(null)

  // Load providers on mount
  React.useEffect(() => {
    refreshProviders()
    refreshConfiguredProviders()
    if (workspacePath) {
      refreshCustomProviderIds(workspacePath)
    }
  }, [])

  // Restart OpenCode sidecar so newly connected providers take effect
  const restartOpenCodeAndRefresh = async () => {
    if (!workspacePath) return
    const { setOpenCodeReady } = useWorkspaceStore.getState()
    try {
      setOpenCodeReady(false)
      await invoke('stop_opencode')
      const status = await invoke<{ url: string }>('start_opencode', {
        config: { workspace_path: workspacePath },
      })
      // Pass workspacePath so API requests include the directory param
      initOpenCodeClient({ baseUrl: status.url, workspacePath })
      setOpenCodeReady(true, status.url)
      await initAll()
    } catch (err) {
      console.error('Failed to restart OpenCode after provider connect:', err)
      setOpenCodeReady(true)
      // Fallback: just refresh without restart
      await Promise.all([refreshProviders(), refreshConfiguredProviders()])
    }
  }

  const handleConnectClick = (providerId: string, providerName: string) => {
    setConnectingProviderId(providerId)
    setConnectingProviderName(providerName)
    setApiKeyInput('')
    setConnectDialogOpen(true)
  }

  const handleConnectSubmit = async () => {
    if (!apiKeyInput.trim()) return
    setIsConnecting(true)
    const success = await connectProvider(connectingProviderId, apiKeyInput.trim())
    if (success) {
      setConnectDialogOpen(false)
      setApiKeyInput('')
      await restartOpenCodeAndRefresh()
    }
    setIsConnecting(false)
  }

  const handleProviderClick = (providerId: string, configured: boolean, providerName: string) => {
    if (configured) {
      setSelectedProviderId(selectedProviderId === providerId ? null : providerId)
    } else {
      handleConnectClick(providerId, providerName)
    }
  }

  const getProviderModels = (providerId: string) => {
    const cp = configuredProviders.find((p) => p.id === providerId)
    return cp?.models || []
  }

  const [isRefreshing, setIsRefreshing] = React.useState(false)

  const handleRefreshProviders = async () => {
    setIsRefreshing(true)
    await restartOpenCodeAndRefresh()
    if (workspacePath) {
      await refreshCustomProviderIds(workspacePath)
    }
    setIsRefreshing(false)
  }

  const handleOpenAddCustomDialog = () => {
    setEditingProviderId(null)
    setCustomName('')
    setCustomBaseURL('')
    setCustomApiKey('')
    setCustomModels([{ modelId: '', modelName: '', contextLimit: '', outputLimit: '' }])
    setCustomDialogOpen(true)
  }

  const handleOpenEditCustomDialog = async (providerId: string) => {
    if (!workspacePath) return
    setEditingProviderId(providerId)
    
    const config = await getCustomProvider(workspacePath, providerId)
    if (config) {
      setCustomName(config.name)
      setCustomBaseURL(config.baseURL)
      setCustomApiKey('')
      setCustomModels(config.models.map(m => ({
        modelId: m.modelId,
        modelName: m.modelName || '',
        contextLimit: m.limit?.context?.toString() || '',
        outputLimit: m.limit?.output?.toString() || '',
      })))
      setCustomDialogOpen(true)
    }
  }

  const handleAddCustomSubmit = async () => {
    if (!customName.trim() || !customBaseURL.trim() || !workspacePath) return
    
    // Validate at least one model with valid modelId
    const validModels = customModels.filter(m => m.modelId.trim())
    if (validModels.length === 0) return
    
    const providerConfig = {
      name: customName.trim(),
      baseURL: customBaseURL.trim(),
      models: validModels.map(m => {
        const contextLimit = m.contextLimit.trim() ? parseInt(m.contextLimit.trim()) : undefined
        const outputLimit = m.outputLimit.trim() ? parseInt(m.outputLimit.trim()) : undefined
        
        // Only include limit if at least one valid number is provided
        const limit = (contextLimit && !isNaN(contextLimit)) || (outputLimit && !isNaN(outputLimit))
          ? {
              context: contextLimit && !isNaN(contextLimit) ? contextLimit : undefined,
              output: outputLimit && !isNaN(outputLimit) ? outputLimit : undefined,
            }
          : undefined
        
        return {
          modelId: m.modelId.trim(),
          modelName: m.modelName.trim() || undefined,
          limit,
        }
      }),
    }
    
    setIsAddingCustom(true)
    try {
      if (editingProviderId) {
        // Update existing provider
        const success = await updateCustomProvider(workspacePath, editingProviderId, providerConfig)
        if (success) {
          setCustomDialogOpen(false)
          setEditingProviderId(null)
          setCustomName('')
          setCustomBaseURL('')
          setCustomApiKey('')
          setCustomModels([{ modelId: '', modelName: '', contextLimit: '', outputLimit: '' }])
          await restartOpenCodeAndRefresh()
          await refreshCustomProviderIds(workspacePath)
        }
      } else {
        // Add new provider
        if (!customApiKey.trim()) return
        const providerId = await addCustomProvider(workspacePath, providerConfig, customApiKey.trim())

        if (providerId) {
          setCustomDialogOpen(false)
          setCustomName('')
          setCustomBaseURL('')
          setCustomApiKey('')
          setCustomModels([{ modelId: '', modelName: '', contextLimit: '', outputLimit: '' }])
          await restartOpenCodeAndRefresh()
          await connectProvider(providerId, customApiKey.trim())
          await refreshCustomProviderIds(workspacePath)
        }
      }
    } finally {
      setIsAddingCustom(false)
    }
  }

  const handleAddModelRow = () => {
    setCustomModels([...customModels, { modelId: '', modelName: '', contextLimit: '', outputLimit: '' }])
  }

  const handleRemoveModelRow = (index: number) => {
    if (customModels.length > 1) {
      setCustomModels(customModels.filter((_, i) => i !== index))
    }
  }

  const handleModelChange = (index: number, field: 'modelId' | 'modelName' | 'contextLimit' | 'outputLimit', value: string) => {
    const newModels = [...customModels]
    newModels[index] = { ...newModels[index], [field]: value }
    setCustomModels(newModels)
  }

  const handleDeleteCustomProvider = async (providerId: string) => {
    if (!workspacePath) return
    setIsDeleting(true)
    try {
      const success = await removeCustomProvider(workspacePath, providerId)
      if (success) {
        setDeletingProviderId(null)
        await restartOpenCodeAndRefresh()
        await refreshCustomProviderIds(workspacePath)
      }
    } finally {
      setIsDeleting(false)
    }
  }

  const isCustomProvider = (providerId: string) => customProviderIds.includes(providerId)

  const handleDisconnectProvider = async (providerId: string) => {
    setIsDisconnecting(true)
    try {
      const success = await disconnectProvider(providerId)
      if (success) {
        setDisconnectingProviderId(null)
        setDisconnectingProviderName('')
      }
    } finally {
      setIsDisconnecting(false)
    }
  }

  if (teamMode && !devUnlocked) {
    return (
      <div className="space-y-6">
        <SectionHeader
          icon={Brain}
          title={t('settings.llm.title', 'LLM Model')}
          description={t('settings.llm.description', 'Manage AI providers and connect them to enable model selection')}
          iconColor="text-purple-500"
        />
        <SettingCard>
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg flex items-center justify-center bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-400">
              <Shield className="h-4.5 w-4.5" />
            </div>
            <div>
              <p className="text-sm font-medium">{t('settings.llm.managedByTeam', 'Managed by team')}</p>
              <p className="text-xs text-muted-foreground">
                {t('settings.llm.managedByTeamDesc', 'Model configuration is managed by team admin, no personal configuration needed.')}
              </p>
              {teamModelConfig && (
                <p className="text-xs text-muted-foreground mt-1">
                  {teamModelConfig.modelName} · {teamModelConfig.baseUrl}
                </p>
              )}
            </div>
          </div>
        </SettingCard>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <SectionHeader
          icon={Brain}
          title={t('settings.llm.title', 'LLM Model')}
          description={t('settings.llm.description', 'Manage AI providers and connect them to enable model selection')}
          iconColor="text-purple-500"
        />
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleOpenAddCustomDialog}
            className="h-8 gap-1.5 text-xs text-muted-foreground"
            title={t('settings.llm.addCustomTooltip', 'Add custom OpenAI-compatible provider')}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('settings.llm.addCustom', 'Add Custom')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefreshProviders}
            disabled={isRefreshing}
            className="h-8 gap-1.5 text-xs text-muted-foreground"
            title={t('settings.llm.refreshTooltip', 'Refresh providers (restarts OpenCode engine)')}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
            {isRefreshing ? t('settings.llm.refreshing', 'Refreshing...') : t('settings.llm.refresh', 'Refresh')}
          </Button>
        </div>
      </div>

      {/* Loading State */}
      {providersLoading && providers.length === 0 && (
        <SettingCard>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </SettingCard>
      )}

      {/* Provider List */}
      {!providersLoading || providers.length > 0 ? (
        <div className="space-y-3">
          {providers.map((p) => {
            const isConnected = p.configured
            const isExpanded = selectedProviderId === p.id
            const models = isConnected ? getProviderModels(p.id) : []

            return (
              <SettingCard key={p.id} className={cn(
                "cursor-pointer hover:border-primary/30 transition-all",
                isExpanded && "border-primary/40"
              )}>
                <div
                  className="flex items-center justify-between"
                  onClick={() => handleProviderClick(p.id, isConnected, p.name)}
                >
                  <div className="flex items-center gap-3">
                    <div className={cn(
                      "h-9 w-9 rounded-lg flex items-center justify-center text-sm font-medium",
                      isConnected
                        ? "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400"
                        : "bg-muted text-muted-foreground"
                    )}>
                      {p.name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium">{p.name}</p>
                        {isCustomProvider(p.id) && (
                          <span className="inline-flex items-center rounded-full bg-purple-100 dark:bg-purple-900/30 px-1.5 py-0.5 text-[10px] font-medium text-purple-700 dark:text-purple-400">
                            {t('settings.llm.custom', 'Custom')}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {isConnected
                          ? t('settings.llm.modelsAvailable', { count: models.length, defaultValue: `${models.length} model${models.length !== 1 ? 's' : ''} available` })
                          : t('settings.llm.notConnected', 'Not connected')}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {isConnected ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                          title={t('settings.llm.updateApiKeyTooltip', 'Update API key')}
                          onClick={(e) => {
                            e.stopPropagation()
                            handleConnectClick(p.id, p.name)
                          }}
                        >
                          <Key className="h-3.5 w-3.5" />
                        </Button>
                        {isCustomProvider(p.id) && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                              title={t('settings.llm.editCustomTooltip', 'Edit custom provider')}
                              onClick={(e) => {
                                e.stopPropagation()
                                handleOpenEditCustomDialog(p.id)
                              }}
                            >
                              <Settings className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                              title={t('settings.llm.removeCustomTooltip', 'Remove custom provider')}
                              onClick={(e) => {
                                e.stopPropagation()
                                setDeletingProviderId(p.id)
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-orange-600"
                          title={t('settings.llm.disconnectTooltip', 'Disconnect provider')}
                          onClick={(e) => {
                            e.stopPropagation()
                            setDisconnectingProviderId(p.id)
                            setDisconnectingProviderName(p.name)
                          }}
                        >
                          <Plug className="h-3.5 w-3.5" />
                        </Button>
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 dark:bg-green-900/30 px-2.5 py-0.5 text-xs font-medium text-green-700 dark:text-green-400">
                          <CircleDot className="h-3 w-3" />
                          {t('settings.llm.connected', 'Connected')}
                        </span>
                      </>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleConnectClick(p.id, p.name)
                        }}
                      >
                        <Key className="h-3 w-3 mr-1" />
                        {t('settings.llm.connect', 'Connect')}
                      </Button>
                    )}
                    {isConnected && (
                      <ChevronRight className={cn(
                        "h-4 w-4 text-muted-foreground transition-transform",
                        isExpanded && "rotate-90"
                      )} />
                    )}
                  </div>
                </div>

                {/* Expanded model list for connected provider */}
                {isConnected && isExpanded && models.length > 0 && (
                  <div className="mt-4 pt-4 border-t space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground mb-2">{t('settings.llm.availableModels', 'Available Models')}</p>
                    {models.map((m) => (
                      <div key={m.id} className="flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-muted/50 text-sm">
                        <Zap className="h-3.5 w-3.5 text-muted-foreground" />
                        <span>{m.name}</span>
                        <span className="text-xs text-muted-foreground ml-auto">{m.id}</span>
                      </div>
                    ))}
                  </div>
                )}
              </SettingCard>
            )
          })}

          {providers.length === 0 && !providersLoading && (
            <SettingCard>
              <div className="text-center py-6 text-muted-foreground">
                <Plug className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">{t('settings.llm.noProviders', 'No providers available')}</p>
                <p className="text-xs mt-1">{t('settings.llm.noProvidersHint', 'Make sure OpenCode is running and connected.')}</p>
              </div>
            </SettingCard>
          )}
        </div>
      ) : null}

      {/* Connect Provider Dialog */}
      <Dialog open={connectDialogOpen} onOpenChange={setConnectDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.llm.connectTitle', { provider: connectingProviderName, defaultValue: `Connect ${connectingProviderName}` })}</DialogTitle>
            <DialogDescription>
              {t('settings.llm.connectDescription', 'Enter your API key to connect this provider. Your key is stored locally.')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium flex items-center gap-2">
                <Key className="h-4 w-4 text-muted-foreground" />
                {t('settings.llm.apiKey', 'API Key')}
              </label>
              <div className="relative">
                <Input
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder={t('settings.llm.apiKeyPlaceholder', 'sk-...')}
                  className="h-11 pr-10"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && apiKeyInput.trim()) {
                      handleConnectSubmit()
                    }
                  }}
                />
                <Shield className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              </div>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Shield className="h-3 w-3" />
                {t('settings.llm.apiKeyPrivacy', 'Your API key is stored locally and never sent to our servers.')}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConnectDialogOpen(false)}
              disabled={isConnecting}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              onClick={handleConnectSubmit}
              disabled={isConnecting || !apiKeyInput.trim()}
              className="gap-2"
            >
              {isConnecting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('settings.llm.connecting', 'Connecting...')}
                </>
              ) : (
                <>
                  <Link className="h-4 w-4" />
                  {t('settings.llm.connect', 'Connect')}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add/Edit Custom Provider Dialog */}
      <Dialog open={customDialogOpen} onOpenChange={(open) => {
        setCustomDialogOpen(open)
        if (!open) setEditingProviderId(null)
      }}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>
              {editingProviderId 
                ? t('settings.llm.editCustomProvider', 'Edit Custom Provider')
                : t('settings.llm.addCustomProvider', 'Add Custom Provider')}
            </DialogTitle>
            <DialogDescription>
              {editingProviderId
                ? t('settings.llm.editCustomProviderDesc', 'Update your custom OpenAI-compatible provider configuration.')
                : t('settings.llm.addCustomProviderDesc', 'Add an OpenAI-compatible provider with your own base URL and API key.')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2 overflow-y-auto flex-1">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('settings.llm.providerName', 'Provider Name')}</label>
              <Input
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder={t('settings.llm.providerNamePlaceholder', 'e.g. My OpenAI Proxy')}
                className="h-10"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('settings.llm.baseUrl', 'Base URL')}</label>
              <Input
                value={customBaseURL}
                onChange={(e) => setCustomBaseURL(e.target.value)}
                placeholder={t('settings.llm.baseUrlPlaceholder', 'e.g. https://api.openai.com/v1')}
                className="h-10"
              />
              <p className="text-xs text-muted-foreground">
                {t('settings.llm.baseUrlHint', 'The API endpoint URL (OpenAI-compatible format)')}
              </p>
            </div>
            {!editingProviderId && (
              <div className="space-y-2">
                <label className="text-sm font-medium flex items-center gap-2">
                  <Key className="h-4 w-4 text-muted-foreground" />
                  {t('settings.llm.apiKey', 'API Key')}
                </label>
                <div className="relative">
                  <Input
                    type="password"
                    value={customApiKey}
                    onChange={(e) => setCustomApiKey(e.target.value)}
                    placeholder={t('settings.llm.apiKeyPlaceholder', 'sk-...')}
                    className="h-10 pr-10"
                  />
                  <Shield className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                </div>
              </div>
            )}
            
            {/* Models Section */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">{t('settings.llm.models', 'Models')}</label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleAddModelRow}
                  className="h-7 gap-1.5 text-xs"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t('settings.llm.addModel', 'Add Model')}
                </Button>
              </div>
              
              <div className="space-y-3">
                {customModels.map((model, index) => (
                  <div key={index} className="border rounded-lg p-3 space-y-3 bg-muted/20">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-muted-foreground">
                        {t('settings.llm.modelNumber', { number: index + 1, defaultValue: `Model ${index + 1}` })}
                      </span>
                      {customModels.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveModelRow(index)}
                          className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                    
                    <div className="space-y-2">
                      <label className="text-xs font-medium">{t('settings.llm.modelId', 'Model ID')}</label>
                      <Input
                        value={model.modelId}
                        onChange={(e) => handleModelChange(index, 'modelId', e.target.value)}
                        placeholder={t('settings.llm.modelIdPlaceholder', 'e.g. gpt-4o')}
                        className="h-9"
                      />
                    </div>
                    
                    <div className="space-y-2">
                      <label className="text-xs font-medium">{t('settings.llm.modelName', 'Model Name')} ({t('common.optional', 'Optional')})</label>
                      <Input
                        value={model.modelName}
                        onChange={(e) => handleModelChange(index, 'modelName', e.target.value)}
                        placeholder={t('settings.llm.modelNamePlaceholder', 'e.g. GPT-4o')}
                        className="h-9"
                      />
                    </div>
                    
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <label className="text-xs font-medium">{t('settings.llm.contextLimit', 'Context Limit')} ({t('common.optional', 'Optional')})</label>
                        <Input
                          type="number"
                          value={model.contextLimit}
                          onChange={(e) => handleModelChange(index, 'contextLimit', e.target.value)}
                          placeholder={t('settings.llm.contextLimitPlaceholder', 'e.g. 128000')}
                          className="h-9"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-medium">{t('settings.llm.outputLimit', 'Output Limit')} ({t('common.optional', 'Optional')})</label>
                        <Input
                          type="number"
                          value={model.outputLimit}
                          onChange={(e) => handleModelChange(index, 'outputLimit', e.target.value)}
                          placeholder={t('settings.llm.outputLimitPlaceholder', 'e.g. 4096')}
                          className="h-9"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCustomDialogOpen(false)
                setEditingProviderId(null)
              }}
              disabled={isAddingCustom}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              onClick={handleAddCustomSubmit}
              disabled={
                isAddingCustom || 
                !customName.trim() || 
                !customBaseURL.trim() || 
                (!editingProviderId && !customApiKey.trim()) ||
                !customModels.some(m => m.modelId.trim())
              }
              className="gap-2"
            >
              {isAddingCustom ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {editingProviderId 
                    ? t('settings.llm.updating', 'Updating...') 
                    : t('settings.llm.adding', 'Adding...')}
                </>
              ) : (
                <>
                  {editingProviderId ? <Settings className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                  {editingProviderId 
                    ? t('settings.llm.updateProvider', 'Update Provider') 
                    : t('settings.llm.addProvider', 'Add Provider')}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Custom Provider Confirmation Dialog */}
      <Dialog open={!!deletingProviderId} onOpenChange={(open) => { if (!open) setDeletingProviderId(null) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('settings.llm.removeCustomProvider', 'Remove Custom Provider')}</DialogTitle>
            <DialogDescription>
              {t('settings.llm.removeCustomProviderDesc', 'This will remove the provider configuration from opencode.json and restart OpenCode. This action cannot be undone.')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeletingProviderId(null)}
              disabled={isDeleting}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => deletingProviderId && handleDeleteCustomProvider(deletingProviderId)}
              disabled={isDeleting}
              className="gap-2"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('settings.llm.removing', 'Removing...')}
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4" />
                  {t('settings.llm.remove', 'Remove')}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Disconnect Provider Confirmation Dialog */}
      <Dialog open={!!disconnectingProviderId} onOpenChange={(open) => { if (!open) { setDisconnectingProviderId(null); setDisconnectingProviderName('') } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('settings.llm.disconnectProvider', 'Disconnect Provider')}</DialogTitle>
            <DialogDescription>
              {t('settings.llm.disconnectProviderDesc', { provider: disconnectingProviderName, defaultValue: `This will disconnect ${disconnectingProviderName} and remove its authentication credentials. You can reconnect later by entering a new API key.` })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setDisconnectingProviderId(null); setDisconnectingProviderName('') }}
              disabled={isDisconnecting}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => disconnectingProviderId && handleDisconnectProvider(disconnectingProviderId)}
              disabled={isDisconnecting}
              className="gap-2"
            >
              {isDisconnecting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('settings.llm.disconnecting', 'Disconnecting...')}
                </>
              ) : (
                <>
                  <Plug className="h-4 w-4" />
                  {t('settings.llm.disconnect', 'Disconnect')}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
})

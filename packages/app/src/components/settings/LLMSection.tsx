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
  const [customName, setCustomName] = React.useState('')
  const [customBaseURL, setCustomBaseURL] = React.useState('')
  const [customApiKey, setCustomApiKey] = React.useState('')
  const [customModelId, setCustomModelId] = React.useState('')
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
    try {
      await invoke('stop_opencode')
      await new Promise((resolve) => setTimeout(resolve, 500))
      const status = await invoke<{ url: string }>('start_opencode', {
        config: { workspace_path: workspacePath },
      })
      initOpenCodeClient({ baseUrl: status.url })
      // Wait a moment for OpenCode to fully initialize providers
      await new Promise((resolve) => setTimeout(resolve, 500))
      await initAll()
    } catch (err) {
      console.error('Failed to restart OpenCode after provider connect:', err)
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

  const handleAddCustomSubmit = async () => {
    if (!customName.trim() || !customBaseURL.trim() || !customApiKey.trim() || !customModelId.trim() || !workspacePath) return
    setIsAddingCustom(true)
    try {
      const providerId = await addCustomProvider(workspacePath, {
        name: customName.trim(),
        baseURL: customBaseURL.trim(),
        modelId: customModelId.trim(),
      }, customApiKey.trim())

      if (providerId) {
        setCustomDialogOpen(false)
        setCustomName('')
        setCustomBaseURL('')
        setCustomApiKey('')
        setCustomModelId('')
        await restartOpenCodeAndRefresh()
        await connectProvider(providerId, customApiKey.trim())
        await refreshCustomProviderIds(workspacePath)
      }
    } finally {
      setIsAddingCustom(false)
    }
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

  if (teamMode) {
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
            onClick={() => setCustomDialogOpen(true)}
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

      {/* Add Custom Provider Dialog */}
      <Dialog open={customDialogOpen} onOpenChange={setCustomDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.llm.addCustomProvider', 'Add Custom Provider')}</DialogTitle>
            <DialogDescription>
              {t('settings.llm.addCustomProviderDesc', 'Add an OpenAI-compatible provider with your own base URL and API key.')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
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
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('settings.llm.modelId', 'Model ID')}</label>
              <Input
                value={customModelId}
                onChange={(e) => setCustomModelId(e.target.value)}
                placeholder={t('settings.llm.modelIdPlaceholder', 'e.g. gpt-4o')}
                className="h-10"
              />
              <p className="text-xs text-muted-foreground">
                {t('settings.llm.modelIdHint', 'The model identifier to use with this provider')}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCustomDialogOpen(false)}
              disabled={isAddingCustom}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              onClick={handleAddCustomSubmit}
              disabled={isAddingCustom || !customName.trim() || !customBaseURL.trim() || !customApiKey.trim() || !customModelId.trim()}
              className="gap-2"
            >
              {isAddingCustom ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('settings.llm.adding', 'Adding...')}
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4" />
                  {t('settings.llm.addProvider', 'Add Provider')}
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

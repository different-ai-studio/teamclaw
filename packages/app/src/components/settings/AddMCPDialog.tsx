import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Loader2,
  Terminal,
  Link,
  AlertCircle,
  Plus,
  Trash2,
  Eye,
  EyeOff,
} from 'lucide-react'
import { type MCPServerConfig } from '@/stores/mcp'
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

interface AddMCPDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingServer?: { name: string; config: MCPServerConfig } | null
  onSave: (name: string, config: MCPServerConfig) => Promise<void>
}

interface EnvVar {
  id: string
  key: string
  value: string
  showValue: boolean
}

export function AddMCPDialog({
  open,
  onOpenChange,
  editingServer,
  onSave,
}: AddMCPDialogProps) {
  const { t } = useTranslation()
  const [serverType, setServerType] = React.useState<'local' | 'remote'>('local')
  const [name, setName] = React.useState('')
  const [command, setCommand] = React.useState('')
  const [envVars, setEnvVars] = React.useState<EnvVar[]>([])
  const [headerVars, setHeaderVars] = React.useState<EnvVar[]>([])
  const [url, setUrl] = React.useState('')
  const [isSaving, setIsSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const isEditing = !!editingServer

  // Convert array to object
  const arrayToObject = (vars: EnvVar[]): Record<string, string> => {
    const obj: Record<string, string> = {}
    vars.forEach((v) => {
      if (v.key.trim()) {
        obj[v.key.trim()] = v.value
      }
    })
    return obj
  }

  // Convert object to array
  const objectToArray = (obj: Record<string, string>): EnvVar[] => {
    return Object.entries(obj).map(([key, val]) => ({
      id: Math.random().toString(36).slice(2),
      key,
      value: val,
      showValue: false,
    }))
  }

  // Reset form when dialog opens/closes or editing server changes
  React.useEffect(() => {
    if (open) {
      if (editingServer) {
        setName(editingServer.name)
        setServerType(editingServer.config.type)
        setCommand(editingServer.config.command?.join(' ') || '')
        setEnvVars(objectToArray(editingServer.config.environment || {}))
        setUrl(editingServer.config.url || '')
        setHeaderVars(objectToArray(editingServer.config.headers || {}))
      } else {
        setName('')
        setServerType('local')
        setCommand('')
        setEnvVars([])
        setUrl('')
        setHeaderVars([])
      }
      setError(null)
    }
  }, [open, editingServer])

  const handleSave = async () => {
    if (!name.trim()) {
      setError('Server name is required')
      return
    }

    if (serverType === 'local' && !command.trim()) {
      setError('Command is required for local servers')
      return
    }

    if (serverType === 'remote' && !url.trim()) {
      setError('URL is required for remote servers')
      return
    }

    setIsSaving(true)
    setError(null)

    try {
      const config: MCPServerConfig = {
        type: serverType,
        enabled: true,
      }

      if (serverType === 'local') {
        config.command = command.trim().split(/\s+/)
        const env = arrayToObject(envVars)
        if (Object.keys(env).length > 0) {
          config.environment = env
        }
      } else {
        config.url = url.trim()
        const hdrs = arrayToObject(headerVars)
        if (Object.keys(hdrs).length > 0) {
          config.headers = hdrs
        }
      }

      await onSave(name.trim(), config)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{isEditing ? t('settings.mcp.editTitle', 'Edit MCP Server') : t('settings.mcp.addTitle', 'Add MCP Server')}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? t('settings.mcp.editDescription', 'Modify the MCP server configuration.')
              : t('settings.mcp.addDescription', 'Configure a new Model Context Protocol server connection.')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Server Name */}
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('settings.mcp.serverName', 'Server Name')}</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('settings.mcp.serverNamePlaceholder', 'my-mcp-server')}
              disabled={isEditing}
            />
            <p className="text-xs text-muted-foreground">
              {t('settings.mcp.serverNameHint', 'A unique identifier for this server')}
            </p>
          </div>

          {/* Server Type */}
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('settings.mcp.serverType', 'Server Type')}</label>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setServerType('local')}
                className={cn(
                  'flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all',
                  serverType === 'local'
                    ? 'border-primary bg-primary/5'
                    : 'border-transparent bg-muted/50 hover:bg-muted'
                )}
              >
                <Terminal
                  className={cn(
                    'h-5 w-5',
                    serverType === 'local' ? 'text-primary' : 'text-muted-foreground'
                  )}
                />
                <span
                  className={cn(
                    'text-sm',
                    serverType === 'local' ? 'font-medium' : 'text-muted-foreground'
                  )}
                >
                  {t('settings.mcp.local', 'Local')}
                </span>
              </button>
              <button
                onClick={() => setServerType('remote')}
                className={cn(
                  'flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all',
                  serverType === 'remote'
                    ? 'border-primary bg-primary/5'
                    : 'border-transparent bg-muted/50 hover:bg-muted'
                )}
              >
                <Link
                  className={cn(
                    'h-5 w-5',
                    serverType === 'remote' ? 'text-primary' : 'text-muted-foreground'
                  )}
                />
                <span
                  className={cn(
                    'text-sm',
                    serverType === 'remote' ? 'font-medium' : 'text-muted-foreground'
                  )}
                >
                  {t('settings.mcp.remote', 'Remote')}
                </span>
              </button>
            </div>
          </div>

          {/* Local Server Fields */}
          {serverType === 'local' && (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('settings.mcp.command', 'Command')}</label>
                <Input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder={t('settings.mcp.commandPlaceholder', 'npx -y @anthropic/mcp-server-filesystem')}
                />
                <p className="text-xs text-muted-foreground">
                  {t('settings.mcp.commandHint', 'The command to start the MCP server')}
                </p>
              </div>
              {/* Environment Variables */}
              <div className="space-y-2">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium">
                    {t('settings.mcp.envVars', '环境变量')} <span className="text-muted-foreground font-normal">({t('common.optional', '可选')})</span>
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEnvVars([
                        ...envVars,
                        {
                          id: Math.random().toString(36).slice(2),
                          key: '',
                          value: '',
                          showValue: true,
                        },
                      ])
                    }}
                    className="h-7 gap-1.5"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t('settings.mcp.addEnvVar', '添加变量')}
                  </Button>
                </div>

                {envVars.length === 0 ? (
                  <div className="text-center py-6 px-4 border border-dashed rounded-lg bg-muted/30">
                    <p className="text-sm text-muted-foreground">
                      {t('settings.mcp.noEnvVars', '暂无环境变量，点击上方按钮添加')}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {envVars.map((envVar, index) => (
                      <div
                        key={envVar.id}
                        className="flex items-center gap-2 p-2 rounded-lg border bg-background/50 hover:bg-muted/50 transition-colors"
                      >
                        <div className="flex-1 grid grid-cols-2 gap-2">
                          <Input
                            placeholder={t('settings.mcp.envKeyPlaceholder', 'API_KEY')}
                            value={envVar.key}
                            onChange={(e) => {
                              const newVars = [...envVars]
                              newVars[index] = { ...envVar, key: e.target.value }
                              setEnvVars(newVars)
                            }}
                            className="h-8 font-mono text-sm"
                          />
                          <div className="relative">
                            <Input
                              type={envVar.showValue ? 'text' : 'password'}
                              placeholder={t('settings.mcp.envValuePlaceholder', 'your-value')}
                              value={envVar.value}
                              onChange={(e) => {
                                const newVars = [...envVars]
                                newVars[index] = { ...envVar, value: e.target.value }
                                setEnvVars(newVars)
                              }}
                              className="h-8 font-mono text-sm pr-8"
                            />
                            <button
                              type="button"
                              onClick={() => {
                                const newVars = [...envVars]
                                newVars[index] = { ...envVar, showValue: !envVar.showValue }
                                setEnvVars(newVars)
                              }}
                              className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                            >
                              {envVar.showValue ? (
                                <EyeOff className="h-3.5 w-3.5" />
                              ) : (
                                <Eye className="h-3.5 w-3.5" />
                              )}
                            </button>
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            setEnvVars(envVars.filter((v) => v.id !== envVar.id))
                          }}
                          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {/* Remote Server Fields */}
          {serverType === 'remote' && (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('settings.mcp.url', 'URL')}</label>
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder={t('settings.mcp.urlPlaceholder', 'https://mcp.example.com/mcp')}
                />
                <p className="text-xs text-muted-foreground">{t('settings.mcp.urlHint', 'The URL of the remote MCP server')}</p>
              </div>
              {/* Headers */}
              <div className="space-y-2">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium">
                    {t('settings.mcp.headers', 'Headers')} <span className="text-muted-foreground font-normal">({t('common.optional', '可选')})</span>
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setHeaderVars([
                        ...headerVars,
                        {
                          id: Math.random().toString(36).slice(2),
                          key: '',
                          value: '',
                          showValue: true,
                        },
                      ])
                    }}
                    className="h-7 gap-1.5"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t('settings.mcp.addHeader', '添加请求头')}
                  </Button>
                </div>

                {headerVars.length === 0 ? (
                  <div className="text-center py-6 px-4 border border-dashed rounded-lg bg-muted/30">
                    <p className="text-sm text-muted-foreground">
                      {t('settings.mcp.noHeaders', '暂无请求头，点击上方按钮添加')}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {headerVars.map((headerVar, index) => (
                      <div
                        key={headerVar.id}
                        className="flex items-center gap-2 p-2 rounded-lg border bg-background/50 hover:bg-muted/50 transition-colors"
                      >
                        <div className="flex-1 grid grid-cols-2 gap-2">
                          <Input
                            placeholder={t('settings.mcp.headerKeyPlaceholder', 'Authorization')}
                            value={headerVar.key}
                            onChange={(e) => {
                              const newVars = [...headerVars]
                              newVars[index] = { ...headerVar, key: e.target.value }
                              setHeaderVars(newVars)
                            }}
                            className="h-8 font-mono text-sm"
                          />
                          <Input
                            type="text"
                            placeholder={t('settings.mcp.headerValuePlaceholder', 'Bearer your-token')}
                            value={headerVar.value}
                            onChange={(e) => {
                              const newVars = [...headerVars]
                              newVars[index] = { ...headerVar, value: e.target.value }
                              setHeaderVars(newVars)
                            }}
                            className="h-8 font-mono text-sm"
                          />
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            setHeaderVars(headerVars.filter((v) => v.id !== headerVar.id))
                          }}
                          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {/* Error Message */}
          {error && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                {t('settings.mcp.saving', 'Saving...')}
              </>
            ) : isEditing ? (
              t('settings.mcp.saveChanges', 'Save Changes')
            ) : (
              t('settings.mcp.addServer', 'Add Server')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

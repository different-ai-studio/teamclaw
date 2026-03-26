import React, { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { WebDavSyncStatus, WebDavSyncResult } from '@/lib/git/types'
import { TEAM_REPO_DIR } from '@/lib/build-config'

function SettingCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border/50 bg-card/50 p-4">
      <h4 className="mb-3 text-sm font-medium text-foreground/80">{title}</h4>
      {children}
    </div>
  )
}

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

export function TeamWebDavConfig() {
  // Form state
  const [url, setUrl] = useState('')
  const [authType, setAuthType] = useState<'basic' | 'bearer'>('basic')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [syncInterval, setSyncInterval] = useState(5)

  // Connection state
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected')
  const [status, setStatus] = useState<WebDavSyncStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Import/Export state
  const [exportPassword, setExportPassword] = useState('')
  const [importPassword, setImportPassword] = useState('')
  const [importFile, setImportFile] = useState<string | null>(null)
  const [showExport, setShowExport] = useState(false)
  const [showImport, setShowImport] = useState(false)

  const loadStatus = useCallback(async () => {
    try {
      const s = await invoke<WebDavSyncStatus>('webdav_get_status')
      setStatus(s)
      setConnectionState(s.connected ? 'connected' : 'disconnected')
      if (s.error) setError(s.error)
    } catch {
      // Not connected yet
    }
  }, [])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  const handleSync = async () => {
    try {
      await invoke<WebDavSyncResult>('webdav_sync')
      await loadStatus()
    } catch (e) {
      setError(String(e))
    }
  }

  const handleConnect = async () => {
    setConnectionState('connecting')
    setError(null)
    try {
      const auth = authType === 'basic'
        ? { type: 'basic' as const, username, password }
        : { type: 'bearer' as const, token }

      await invoke('webdav_connect', { url, auth })
      setConnectionState('connected')
      await handleSync()
    } catch (e) {
      setConnectionState('error')
      setError(String(e))
    }
  }

  const handleDisconnect = async () => {
    try {
      await invoke('webdav_disconnect')
      setConnectionState('disconnected')
      setStatus(null)
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }

  const handleExport = async () => {
    try {
      const configJson = await invoke<string>('webdav_export_config', {
        password: exportPassword,
      })
      const blob = new Blob([configJson], { type: 'application/json' })
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = `${TEAM_REPO_DIR}-webdav.json`
      a.click()
      URL.revokeObjectURL(blobUrl)
      setShowExport(false)
      setExportPassword('')
    } catch (e) {
      setError(String(e))
    }
  }

  const handleImport = async () => {
    if (!importFile) return
    try {
      await invoke('webdav_import_config', {
        configJson: importFile,
        password: importPassword,
      })
      setConnectionState('connected')
      setShowImport(false)
      setImportPassword('')
      setImportFile(null)
      await handleSync()
    } catch (e) {
      setError(String(e))
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setImportFile(reader.result as string)
    reader.readAsText(file)
  }

  return (
    <div className="space-y-4">
      {/* Connection Form */}
      {connectionState !== 'connected' && (
        <SettingCard title="WebDAV Configuration">
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">URL</label>
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={`https://dav.example.com/${TEAM_REPO_DIR}/`}
              />
            </div>

            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Auth Type</label>
              <select
                value={authType}
                onChange={(e) => setAuthType(e.target.value as 'basic' | 'bearer')}
                className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="basic">Username + Password</option>
                <option value="bearer">Bearer Token</option>
              </select>
            </div>

            {authType === 'basic' ? (
              <>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Username</label>
                  <Input value={username} onChange={(e) => setUsername(e.target.value)} />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Password</label>
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
              </>
            ) : (
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Token</label>
                <Input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </div>
            )}

            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Sync Interval (minutes)</label>
              <Input
                type="number"
                min={1}
                max={60}
                value={syncInterval}
                onChange={(e) => setSyncInterval(Number(e.target.value))}
              />
            </div>

            <div className="flex gap-2">
              <Button
                onClick={handleConnect}
                disabled={connectionState === 'connecting' || !url}
              >
                {connectionState === 'connecting' ? 'Connecting...' : 'Connect'}
              </Button>
              <Button variant="outline" onClick={() => setShowImport(true)}>
                Import Config
              </Button>
            </div>
          </div>
        </SettingCard>
      )}

      {/* Connected Status */}
      {connectionState === 'connected' && status && (
        <SettingCard title="Sync Status">
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-green-500" />
              <span>Connected</span>
            </div>
            {status.lastSyncAt && (
              <div className="text-muted-foreground">
                Last sync: {new Date(status.lastSyncAt).toLocaleString()}
              </div>
            )}
            <div className="text-muted-foreground">Files: {status.fileCount}</div>
            <div className="flex gap-2 pt-2">
              <Button
                size="sm"
                onClick={handleSync}
                disabled={status.syncing}
              >
                {status.syncing ? 'Syncing...' : 'Sync Now'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setShowExport(true)}>
                Export Config
              </Button>
              <Button size="sm" variant="destructive" onClick={handleDisconnect}>
                Disconnect
              </Button>
            </div>
          </div>
        </SettingCard>
      )}

      {/* Error display */}
      {error && (
        <div className="rounded border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Export Dialog */}
      {showExport && (
        <SettingCard title="Export Configuration">
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Set a password to encrypt the config file. Share the file and password separately with team members.
            </p>
            <Input
              type="password"
              placeholder="Password (min 8 characters)"
              value={exportPassword}
              onChange={(e) => setExportPassword(e.target.value)}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleExport}
                disabled={exportPassword.length < 8}
              >
                Export
              </Button>
              <Button size="sm" variant="outline" onClick={() => setShowExport(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </SettingCard>
      )}

      {/* Import Dialog */}
      {showImport && (
        <SettingCard title="Import Configuration">
          <div className="space-y-2">
            <input
              type="file"
              accept=".json"
              onChange={handleFileSelect}
              className="text-sm"
            />
            <Input
              type="password"
              placeholder="Password"
              value={importPassword}
              onChange={(e) => setImportPassword(e.target.value)}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleImport}
                disabled={!importFile || !importPassword}
              >
                Import
              </Button>
              <Button size="sm" variant="outline" onClick={() => setShowImport(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </SettingCard>
      )}
    </div>
  )
}

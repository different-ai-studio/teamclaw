import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'

const mockReloadDaemonRuntime = vi.fn()
const mockSetCatalogEntry = vi.fn()
const mockEncodeWorkspaceId = vi.fn((path: string) => path)
const mockInvoke = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOptions?: string | Record<string, unknown>) => {
      if (typeof fallbackOrOptions === 'string') return fallbackOrOptions
      if (fallbackOrOptions && typeof fallbackOrOptions === 'object') {
        const { defaultValue, ...vars } = fallbackOrOptions
        let text = String(defaultValue ?? key)
        for (const [name, value] of Object.entries(vars)) {
          text = text.replace(new RegExp(`\\{\\{${name}\\}\\}`, 'g'), String(value))
        }
        return text
      }
      return key
    },
    i18n: { language: 'en' },
  }),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}))

const mockGetDaemonEnvActivationDiagnostics = vi.fn()

vi.mock('@/lib/daemon-local-client', () => ({
  reloadDaemonRuntime: (...args: unknown[]) => mockReloadDaemonRuntime(...args),
  encodeWorkspaceId: (path: string) => mockEncodeWorkspaceId(path),
  getDaemonEnvActivationDiagnostics: (...args: unknown[]) => mockGetDaemonEnvActivationDiagnostics(...args),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ workspacePath: '/workspace/demo' }),
    {
      getState: () => ({ workspacePath: '/workspace/demo' }),
    },
  ),
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement('button', props, children),
}))

vi.mock('@/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) => React.createElement('input', props),
}))

vi.mock('@/components/ui/checkbox', () => ({
  Checkbox: (props: Record<string, unknown>) => React.createElement('input', { type: 'checkbox', ...props }),
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: React.PropsWithChildren<{ open?: boolean }>) =>
    open ? React.createElement('div', null, children) : null,
  DialogContent: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DialogDescription: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DialogFooter: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DialogHeader: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DialogTitle: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
}))

vi.mock('@/components/settings/shared', () => ({
  SettingCard: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', { 'data-testid': 'setting-card' }, children),
  SectionHeader: ({ title }: { title: string }) =>
    React.createElement('div', { 'data-testid': 'section-header' }, title),
}))

vi.mock('@/stores/env-vars', () => ({
  useEnvVarsStore: Object.assign(
    () => ({
      envVars: [],
      teamSecrets: [],
      isLoading: false,
      loadEnvCatalog: vi.fn(),
      setCatalogEntry: (...args: unknown[]) => mockSetCatalogEntry(...args),
      deleteCatalogEntry: vi.fn(),
      getEnvVarValue: vi.fn(),
      hasChanges: false,
      setHasChanges: vi.fn(),
    }),
    {
      getState: () => ({ error: null }),
    },
  ),
}))

vi.mock('@/stores/team-members', () => ({
  useTeamMembersStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      currentNodeId: 'node-1',
      loadCurrentNodeId: vi.fn(),
    }),
}))

vi.mock('@/lib/team-permissions', () => ({
  useTeamPermissions: () => ({ role: 'owner', isOwner: true }),
}))

import { EnvVarsSection } from '../EnvVarsSection'

describe('EnvVarsSection reload', () => {
  beforeEach(() => {
    mockReloadDaemonRuntime.mockReset()
    mockSetCatalogEntry.mockReset()
    mockInvoke.mockReset()
    mockGetDaemonEnvActivationDiagnostics.mockReset()
    mockReloadDaemonRuntime.mockResolvedValue('restart_required')
    mockSetCatalogEntry.mockResolvedValue(undefined)
    mockGetDaemonEnvActivationDiagnostics.mockResolvedValue({
      personal_env_var_count: 2,
      personal_blob_user_var_count: 2,
      personal_blob_readable: true,
      personal_load_error: null,
      team_env_var_count: 0,
      system_env_var_count: 3,
      opencode_serve_running: false,
      opencode_serve_cached_env_count: 0,
      active_runtime_count: 0,
      workspace_has_active_turn: false,
      refresh: {
        status: 'clean',
        change_kinds: [],
        recommended_action: 'none',
        auto_apply_blocked_by_active_runtime: false,
        last_detected_at: null,
        last_error: null,
      },
      blockers: [] as { code: string; detail?: string | null }[],
      host_env_shadowed_keys: [],
      resolved_env_fingerprint: 'same-fingerprint',
      active_env_fingerprint: 'same-fingerprint',
      override_keys: [],
      alias_collision_keys: [],
      unresolved_env_keys: [],
      snapshot_conflict_workspace: null,
      activation_status: 'active',
      expected_env_keys: [],
      effective_env_keys: [],
      missing_expected_keys: [],
      key_statuses: [],
      mcp_unresolved_placeholders: [],
      installed_env_fingerprint: 'same-fingerprint',
      active_handle_env_fingerprint: null,
      team_secret_configured: false,
      opencode_serve_cached_env_keys: [],
      missing_served_env_keys: [],
      active_handle_env_keys: [],
    })
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'team_env_diagnostics') {
        return {
          teamIdPresent: false,
          teamLinkPath: '/tmp/link',
          linkExists: false,
          linkIsSymlink: false,
          linkTarget: null,
          targetAccessible: false,
          secretsDirExists: false,
          secretFileCount: 0,
          secretConfigured: false,
        }
      }
      if (cmd === 'personal_env_diagnostics') {
        return {
          storageDir: 'teamclu',
          secretsDir: '/home/user/.teamclu/secrets',
          masterKeyExists: true,
          blobExists: true,
          blobReadable: true,
          blobError: null,
          storedVarCount: 3,
          userStoredVarCount: 2,
          workspaceIndexCount: 2,
          indexKeysMissingFromBlob: [],
          blobKeysMissingFromIndex: [],
          hostShadowedKeys: [],
        }
      }
      return true
    })
  })

  it('reloads daemon runtime after saving a personal env var', async () => {
    const user = userEvent.setup()
    render(<EnvVarsSection />)

    await user.click(screen.getByRole('button', { name: 'Add Variable' }))
    await user.type(screen.getByPlaceholderText('MY_API_KEY'), 'MY_TOKEN')
    await user.type(screen.getByPlaceholderText('sk-...'), 'secret-value')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mockSetCatalogEntry).toHaveBeenCalledWith(
        'personal',
        'MY_TOKEN',
        'secret-value',
        { description: undefined },
      )
      expect(mockReloadDaemonRuntime).toHaveBeenCalledWith('/workspace/demo')
    })
  })

  it('warns when daemon reload returns null', async () => {
    const { toast } = await import('sonner')
    mockReloadDaemonRuntime.mockResolvedValue(null)
    const user = userEvent.setup()
    render(<EnvVarsSection />)

    await user.click(screen.getByRole('button', { name: 'Add Variable' }))
    await user.type(screen.getByPlaceholderText('MY_API_KEY'), 'MY_TOKEN')
    await user.type(screen.getByPlaceholderText('sk-...'), 'secret-value')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalled()
    })
  })
})

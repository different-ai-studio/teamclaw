import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'

const mockReloadDaemonRuntime = vi.fn()
const mockSetCatalogEntry = vi.fn()
const mockEncodeWorkspaceId = vi.fn((path: string) => path)

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback: string) => fallback,
    i18n: { language: 'en' },
  }),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/lib/daemon-local-client', () => ({
  reloadDaemonRuntime: (...args: unknown[]) => mockReloadDaemonRuntime(...args),
  encodeWorkspaceId: (path: string) => mockEncodeWorkspaceId(path),
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
    mockReloadDaemonRuntime.mockResolvedValue('applied_live')
    mockSetCatalogEntry.mockResolvedValue(undefined)
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
})

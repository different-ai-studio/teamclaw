import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'

const { mockLoadEnvVars, mockLoadSecrets, mockListenForChanges } = vi.hoisted(() => ({
  mockLoadEnvVars: vi.fn(),
  mockLoadSecrets: vi.fn(),
  mockListenForChanges: vi.fn(async () => () => {}),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback: string) => fallback,
    i18n: { language: 'en' },
  }),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement('button', props, children),
}))

vi.mock('@/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) => React.createElement('input', props),
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DialogContent: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DialogDescription: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DialogFooter: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DialogHeader: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DialogTitle: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
}))

vi.mock('@/components/settings/shared', () => ({
  SettingCard: ({ children, className }: React.PropsWithChildren<{ className?: string }>) =>
    React.createElement('div', { 'data-testid': 'setting-card', className }, children),
  SectionHeader: ({ title }: { title: string }) =>
    React.createElement('div', { 'data-testid': 'section-header' }, title),
}))

vi.mock('@/stores/env-vars', () => ({
  useEnvVarsStore: () => ({
    envVars: [],
    isLoading: false,
    loadEnvVars: mockLoadEnvVars,
    setEnvVar: vi.fn(),
    deleteEnvVar: vi.fn(),
    getEnvVarValue: vi.fn(),
    hasChanges: false,
    setHasChanges: vi.fn(),
  }),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ workspacePath: '/test' }),
}))

vi.mock('@/lib/opencode/sdk-client', () => ({
  initOpenCodeClient: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))

vi.mock('@/stores/shared-secrets', () => ({
  useSharedSecretsStore: () => ({
    secrets: [],
    isLoading: false,
    loadSecrets: mockLoadSecrets,
    listenForChanges: mockListenForChanges,
    setSecret: vi.fn(),
    deleteSecret: vi.fn(),
  }),
}))

vi.mock('@/stores/team-members', () => ({
  useTeamMembersStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = { members: [], myRole: null, loading: false, currentNodeId: null }
    return selector ? selector(state) : state
  },
}))

const icon = () => React.createElement('span')
vi.mock('lucide-react', () => ({
  KeyRound: icon, Plus: icon, Eye: icon, EyeOff: icon, Pencil: icon,
  Trash2: icon, ShieldCheck: icon, AlertCircle: icon, RefreshCw: icon,
  Loader2: icon, Users: icon, User: icon, Lock: icon, Copy: icon,
  Check: icon, CheckIcon: icon,
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('EnvVarsSection', () => {
  it('renders the section header', async () => {
    const { EnvVarsSection } = await import('@/components/settings/EnvVarsSection')
    render(React.createElement(EnvVarsSection))
    expect(screen.getByTestId('section-header')).toBeDefined()
    expect(screen.getByText('Environment Variables')).toBeDefined()
  })

  it('shows empty state when no env vars', async () => {
    const { EnvVarsSection } = await import('@/components/settings/EnvVarsSection')
    render(React.createElement(EnvVarsSection))
    expect(screen.getByText('No environment variables yet')).toBeDefined()
  })

  it('calls loadEnvVars on mount', async () => {
    const { EnvVarsSection } = await import('@/components/settings/EnvVarsSection')
    render(React.createElement(EnvVarsSection))
    expect(mockLoadEnvVars).toHaveBeenCalled()
  })
})

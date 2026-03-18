import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback: string) => fallback,
    i18n: { language: 'en' },
  }),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue('global'),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn().mockResolvedValue('{}'),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  exists: vi.fn().mockResolvedValue(false),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => false,
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ workspacePath: '/test' }),
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement('button', props, children),
}))

vi.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: React.PropsWithChildren) =>
    React.createElement('span', null, children),
}))

vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  SelectContent: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  SelectItem: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  SelectTrigger: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  SelectValue: () => React.createElement('span'),
}))

vi.mock('@/components/settings/shared', () => ({
  SettingCard: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', { 'data-testid': 'setting-card' }, children),
  SectionHeader: ({ title }: { title: string }) =>
    React.createElement('div', { 'data-testid': 'section-header' }, title),
}))

vi.mock('lucide-react', () => {
  const stub = () => React.createElement('span')
  return {
    Shield: stub, Trash2: stub, RefreshCw: stub, Loader2: stub,
    Terminal: stub, FileEdit: stub, FileText: stub, Check: stub,
    X: stub, AlertTriangle: stub, Save: stub, Database: stub,
  }
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PermissionManagementSection', () => {
  it('renders section header with title', async () => {
    const { PermissionManagementSection } = await import('@/components/settings/PermissionManagementSection')
    render(React.createElement(PermissionManagementSection))
    expect(screen.getByTestId('section-header')).toBeDefined()
    expect(screen.getByText('Permission Management')).toBeDefined()
  })

  it('renders permission configuration section', async () => {
    const { PermissionManagementSection } = await import('@/components/settings/PermissionManagementSection')
    render(React.createElement(PermissionManagementSection))
    expect(screen.getByText('Permission Configuration')).toBeDefined()
  })

  it('renders allowlist section', async () => {
    const { PermissionManagementSection } = await import('@/components/settings/PermissionManagementSection')
    render(React.createElement(PermissionManagementSection))
    expect(screen.getByText('Command Allowlist')).toBeDefined()
  })
})

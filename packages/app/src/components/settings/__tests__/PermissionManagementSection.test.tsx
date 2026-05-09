import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'

const fsMock = vi.hoisted(() => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  exists: vi.fn(),
  mkdir: vi.fn(),
}))

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback: string) => fallback,
    i18n: { language: 'en' },
  }),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: fsMock.readTextFile,
  writeTextFile: fsMock.writeTextFile,
  exists: fsMock.exists,
  mkdir: fsMock.mkdir,
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
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

vi.mock('@/components/ui/input', () => ({
  Input: (props: React.ComponentProps<'input'>) => React.createElement('input', props),
}))

vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  SelectContent: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  SelectItem: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  SelectTrigger: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  SelectValue: () => React.createElement('span'),
}))

vi.mock('@/components/ui/textarea', () => ({
  Textarea: (props: React.ComponentProps<'textarea'>) => React.createElement('textarea', props),
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
    X: stub, AlertTriangle: stub, Save: stub, Database: stub, Plus: stub,
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  invokeMock.mockImplementation((command: string) => {
    if (command === 'get_opencode_project_id') return Promise.resolve('global')
    if (command === 'read_opencode_allowlist') {
      return Promise.resolve([
        {
          project_id: 'global',
          rules: [
            { permission: 'bash', pattern: 'python3 *', action: 'allow' },
          ],
        },
      ])
    }
    return Promise.resolve(undefined)
  })
  fsMock.exists.mockResolvedValue(true)
  fsMock.mkdir.mockResolvedValue(undefined)
  fsMock.writeTextFile.mockResolvedValue(undefined)
  fsMock.readTextFile.mockImplementation((path: string) => {
    if (path.endsWith('/opencode.json')) {
      return Promise.resolve(JSON.stringify({ permission: { bash: 'ask' } }))
    }
    if (path.endsWith('/.teamclaw/production-guard.json')) {
      return Promise.resolve(JSON.stringify({
        version: 1,
        enabled: true,
        rules: [
          {
            id: 'biz-code-delete',
            label: 'biz code delete',
            match: { commandIncludes: ['scripts/delete_biz_codes.py'] },
            risk: 'production_data',
            approval: { mode: 'always_ask', allowAlways: false },
          },
        ],
      }))
    }
    return Promise.resolve('{}')
  })
})

describe('PermissionManagementSection', () => {
  it('renders section header with title', async () => {
    const { PermissionManagementSection } = await import('@/components/settings/PermissionManagementSection')
    render(React.createElement(PermissionManagementSection))
    expect(screen.getByTestId('section-header')).toBeDefined()
    expect(screen.getByText('Permission Management')).toBeDefined()
    expect(await screen.findByText('Active')).toBeDefined()
  })

  it('renders permission configuration section', async () => {
    const { PermissionManagementSection } = await import('@/components/settings/PermissionManagementSection')
    render(React.createElement(PermissionManagementSection))
    expect(screen.getByText('Permission Configuration')).toBeDefined()
    expect(await screen.findByText('Active')).toBeDefined()
  })

  it('renders allowlist section', async () => {
    const { PermissionManagementSection } = await import('@/components/settings/PermissionManagementSection')
    render(React.createElement(PermissionManagementSection))
    expect(screen.getByText('Command Allowlist')).toBeDefined()
    expect(await screen.findByText('Active')).toBeDefined()
  })

  it('renders production guard rules and broad allowlist diagnostics', async () => {
    const { PermissionManagementSection } = await import('@/components/settings/PermissionManagementSection')
    render(React.createElement(PermissionManagementSection))

    expect(await screen.findByText('Production Data Guard')).toBeDefined()
    expect(await screen.findByText('Active')).toBeDefined()
    expect(await screen.findByText('biz code delete')).toBeDefined()
    expect(await screen.findByText('scripts/delete_biz_codes.py')).toBeDefined()
    expect(await screen.findByText('Potential Bypasses')).toBeDefined()
    expect(await screen.findAllByText('python3 *')).toHaveLength(2)
  })

  it('tests pasted commands against production guard rules', async () => {
    const { PermissionManagementSection } = await import('@/components/settings/PermissionManagementSection')
    render(React.createElement(PermissionManagementSection))

    const input = await screen.findByPlaceholderText('Paste a command to test production guard matching')
    fireEvent.change(input, {
      target: {
        value: 'cd /workspace/teamclaw-team/skills/biz-code-delete && python3 scripts/delete_biz_codes.py --env test',
      },
    })
    fireEvent.click(screen.getByText('Test Command'))

    await waitFor(() => {
      expect(screen.getByText('Matched: biz-code-delete')).toBeDefined()
    })
  })

  it('shows invalid production guard config state', async () => {
    fsMock.readTextFile.mockImplementation((path: string) => {
      if (path.endsWith('/opencode.json')) {
        return Promise.resolve(JSON.stringify({ permission: { bash: 'ask' } }))
      }
      if (path.endsWith('/.teamclaw/production-guard.json')) {
        return Promise.resolve('{ invalid json')
      }
      return Promise.resolve('{}')
    })

    const { PermissionManagementSection } = await import('@/components/settings/PermissionManagementSection')
    render(React.createElement(PermissionManagementSection))

    expect(await screen.findByText('Config invalid')).toBeDefined()
    expect(await screen.findByText(/Production guard is disabled/)).toBeDefined()
  })

  it('adds a production guard rule and writes the workspace config', async () => {
    const { PermissionManagementSection } = await import('@/components/settings/PermissionManagementSection')
    render(React.createElement(PermissionManagementSection))

    fireEvent.click(await screen.findByText('Add Rule'))
    expect(screen.queryByLabelText('Paths')).toBeNull()
    expect(screen.queryByLabelText('Regex')).toBeNull()
    expect(screen.queryByLabelText('Environment')).toBeNull()

    fireEvent.change(screen.getByLabelText('Rule ID'), { target: { value: 'orders-prod-delete' } })
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'orders prod delete' } })
    fireEvent.change(screen.getByLabelText('Command includes'), {
      target: { value: 'scripts/delete_orders.py\n--env prod' },
    })
    fireEvent.click(screen.getByText('Save Rule'))

    await waitFor(() => expect(fsMock.writeTextFile).toHaveBeenCalled())
    const [path, content] = fsMock.writeTextFile.mock.calls.at(-1) as [string, string]
    const config = JSON.parse(content)

    expect(path).toBe('/test/.teamclaw/production-guard.json')
    expect(config.rules).toHaveLength(2)
    expect(config.rules[1]).toMatchObject({
      id: 'orders-prod-delete',
      label: 'orders prod delete',
      match: { commandIncludes: ['scripts/delete_orders.py', '--env prod'] },
      risk: 'production_data',
      approval: { mode: 'always_ask', allowAlways: false },
    })
  })

  it('deletes a production guard rule and writes the workspace config', async () => {
    const { PermissionManagementSection } = await import('@/components/settings/PermissionManagementSection')
    render(React.createElement(PermissionManagementSection))

    fireEvent.click(await screen.findByLabelText('Delete production guard rule biz-code-delete'))

    await waitFor(() => expect(fsMock.writeTextFile).toHaveBeenCalled())
    const [, content] = fsMock.writeTextFile.mock.calls.at(-1) as [string, string]
    const config = JSON.parse(content)

    expect(config.rules).toEqual([])
  })

  it('creates the production guard config when adding the first rule', async () => {
    fsMock.exists.mockImplementation((path: string) => {
      if (path.endsWith('/.teamclaw') || path.endsWith('/.teamclaw/production-guard.json')) {
        return Promise.resolve(false)
      }
      return Promise.resolve(true)
    })
    fsMock.readTextFile.mockImplementation((path: string) => {
      if (path.endsWith('/opencode.json')) {
        return Promise.resolve(JSON.stringify({ permission: { bash: 'ask' } }))
      }
      return Promise.resolve('{}')
    })

    const { PermissionManagementSection } = await import('@/components/settings/PermissionManagementSection')
    render(React.createElement(PermissionManagementSection))

    fireEvent.click(await screen.findByText('Add Rule'))
    fireEvent.change(screen.getByLabelText('Rule ID'), { target: { value: 'first-prod-rule' } })
    fireEvent.change(screen.getByLabelText('Command includes'), {
      target: { value: 'dangerous-script.py' },
    })
    fireEvent.click(screen.getByText('Save Rule'))

    await waitFor(() => expect(fsMock.writeTextFile).toHaveBeenCalled())
    const [path, content] = fsMock.writeTextFile.mock.calls.at(-1) as [string, string]
    const config = JSON.parse(content)

    expect(fsMock.mkdir).toHaveBeenCalledWith('/test/.teamclaw', { recursive: true })
    expect(path).toBe('/test/.teamclaw/production-guard.json')
    expect(config).toMatchObject({
      version: 1,
      enabled: true,
      rules: [
        {
          id: 'first-prod-rule',
          label: 'first-prod-rule',
          match: { commandIncludes: ['dangerous-script.py'] },
        },
      ],
    })
  })
})

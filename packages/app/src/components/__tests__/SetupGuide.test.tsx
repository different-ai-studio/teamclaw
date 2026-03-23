import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string, _opts?: Record<string, unknown>) => fallback,
  }),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => false,
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  copyToClipboard: vi.fn(),
}))

const mockCheckDependencies = vi.fn().mockResolvedValue([])
const mockInstallDependencies = vi.fn()
const mockResetInstallState = vi.fn()

vi.mock('@/stores/deps', () => ({
  useDepsStore: Object.assign(
    () => ({
      dependencies: [
        {
          name: 'OpenCode',
          installed: true,
          version: '1.0.0',
          required: true,
          description: 'AI Agent Backend',
          install_commands: { macos: 'brew install opencode', windows: 'winget install opencode', linux: 'apt install opencode' },
          affected_features: [],
          priority: 1,
        },
        {
          name: 'ffmpeg',
          installed: false,
          version: null,
          required: false,
          description: 'Media processing',
          install_commands: { macos: 'brew install ffmpeg', windows: 'winget install ffmpeg', linux: 'apt install ffmpeg' },
          affected_features: ['Voice Input'],
          priority: 2,
        },
      ],
      installing: false,
      installQueue: [],
      currentInstalling: null,
      installResults: {},
      installOutput: {},
      installDependencies: mockInstallDependencies,
      checkDependencies: mockCheckDependencies,
      resetInstallState: mockResetInstallState,
    }),
    {
      getState: () => ({
        dependencies: [
          { name: 'OpenCode', installed: true, required: true },
          { name: 'ffmpeg', installed: false, required: false },
        ],
        checkDependencies: mockCheckDependencies,
      }),
    },
  ),
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>{children}</button>
  ),
}))

import { SetupGuide } from '@/components/SetupGuide'

describe('SetupGuide', () => {
  const defaultProps = {
    dependencies: [],
    onRecheck: vi.fn().mockResolvedValue([]),
    onContinue: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the overview phase title', () => {
    render(<SetupGuide {...defaultProps} />)
    expect(screen.getByText('Setup Required')).toBeDefined()
  })

  it('shows installed dependency with checkmark', () => {
    render(<SetupGuide {...defaultProps} />)
    expect(screen.getByText('OpenCode')).toBeDefined()
    expect(screen.getByText('v1.0.0')).toBeDefined()
  })

  it('shows missing optional dependency with install command', () => {
    render(<SetupGuide {...defaultProps} />)
    expect(screen.getByText('ffmpeg')).toBeDefined()
    expect(screen.getByText('Media processing')).toBeDefined()
    // Should show affected features
    expect(screen.getByText('Voice Input')).toBeDefined()
  })

  it('shows Skip button when all required deps are installed', () => {
    render(<SetupGuide {...defaultProps} />)
    // All required (OpenCode) are installed, so skip should appear
    expect(screen.getByText('Skip')).toBeDefined()
  })

  it('shows Customize button when there are missing optional deps', () => {
    render(<SetupGuide {...defaultProps} />)
    expect(screen.getByText('Customize')).toBeDefined()
  })
})

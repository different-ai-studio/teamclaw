import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => d ?? k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}))
vi.mock('@/stores/channels', () => ({
  useChannelsStore: vi.fn(() => ({
    wecom: { botId: '', secret: '', enabled: false, encodingAesKey: '' },
    wecomIsLoading: false,
    wecomGatewayStatus: { status: 'disconnected', botId: '', errorMessage: '' },
    wecomHasChanges: false,
    wecomIsTesting: false,
    wecomTestResult: null,
    loadWecomConfig: vi.fn(),
    saveWecomConfig: vi.fn(), startWecomGateway: vi.fn(), stopWecomGateway: vi.fn(),
    refreshWecomStatus: vi.fn(), testWecomCredentials: vi.fn(), clearWecomTestResult: vi.fn(),
    setWecomHasChanges: vi.fn(), toggleWecomEnabled: vi.fn(),
  })),
  defaultWeComConfig: { botId: '', secret: '', enabled: false, encodingAesKey: '' },
}))
vi.mock('./shared', () => ({
  WeComIcon: () => <span data-testid="wecom-icon" />,
  SettingCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ToggleSwitch: ({ enabled }: { enabled: boolean }) => <input type="checkbox" checked={enabled} readOnly />,
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}))
vi.mock('./GatewayStatusCard', () => ({
  GatewayStatusCard: ({ children, title }: { children: React.ReactNode; title: string }) => <div><span>{title}</span>{children}</div>,
}))
vi.mock('./TestCredentialsButton', () => ({
  TestCredentialsButton: () => <button>Test</button>,
}))
vi.mock('@/hooks/useChannelConfig', () => ({
  useChannelConfig: () => ({
    localConfig: { botId: '', secret: '', enabled: false, encodingAesKey: '' },
    updateLocalConfig: vi.fn(),
    isConnecting: false,
    isRunning: false,
    handleSave: vi.fn(),
    handleStartStop: vi.fn(),
    handleRestart: vi.fn(),
  }),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/lib/utils', () => ({ cn: (...args: string[]) => args.join(' '), openExternalUrl: vi.fn() }))

import { WeComChannel } from '../Wecom'

describe('WeComChannel', () => {
  it('renders the WeCom Gateway header', () => {
    render(<WeComChannel />)
    expect(screen.getByText('WeCom Gateway')).toBeTruthy()
  })
})

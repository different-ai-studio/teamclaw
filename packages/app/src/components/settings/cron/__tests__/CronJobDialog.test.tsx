import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => d ?? k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}))
vi.mock('@/stores/cron', () => ({
  useCronStore: vi.fn(() => ({
    createJob: vi.fn(),
    updateJob: vi.fn(),
    sessions: [],
    isLoading: false,
  })),
}))
vi.mock('@/stores/channels', () => ({
  useChannelsStore: vi.fn(() => ({
    discord: null,
    feishu: null,
    email: null,
    kook: null,
    wecom: null,
  })),
}))
vi.mock('@/stores/provider', () => ({
  useProviderStore: vi.fn(() => ({
    providers: [],
    configuredProviders: [],
  })),
}))
vi.mock('@/lib/utils', () => ({ cn: (...a: string[]) => a.join(' ') }))
vi.mock('../../shared', () => ({
  ToggleSwitch: ({ enabled }: { enabled: boolean }) => <input type="checkbox" checked={enabled} readOnly />,
}))
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}))
vi.mock('@/components/ui/input', () => ({
  Input: (props: any) => <input {...props} />,
}))
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: any) => <div>{children}</div>,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children }: any) => <div>{children}</div>,
  SelectTrigger: ({ children }: any) => <div>{children}</div>,
  SelectValue: () => null,
}))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) => open ? <div>{children}</div> : null,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
}))
vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: any) => <div>{children}</div>,
}))

// Need to mock the form helpers
vi.mock('../form-helpers', () => ({
  defaultFormState: vi.fn(() => ({
    name: '', prompt: '', scheduleKind: 'interval', intervalMinutes: 60,
    cronExpr: '', enabled: true, deliveryChannel: 'session', discordChannelId: '',
    feishuChatId: '', emailTo: '', model: '',
  })),
  jobToFormState: vi.fn(),
  formStateToSchedule: vi.fn(() => ({ interval_minutes: 60 })),
  formStateToPayload: vi.fn(() => ({})),
  formStateToDelivery: vi.fn(() => ({})),
}))

import { CronJobDialog } from '../CronJobDialog'

describe('CronJobDialog', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <CronJobDialog open={false} onOpenChange={vi.fn()} onSaved={vi.fn()} />
    )
    expect(container.innerHTML).toBe('')
  })
})

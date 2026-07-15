import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => d ?? k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}))
vi.mock('@/lib/utils', () => ({ cn: (...a: string[]) => a.join(' '), openExternalUrl: vi.fn() }))
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}))
vi.mock('@/components/ui/input', () => ({
  Input: (props: any) => <input {...props} />,
}))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) => open ? <div>{children}</div> : null,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
}))
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: any) => <div>{children}</div>,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children }: any) => <div>{children}</div>,
  SelectTrigger: ({ children }: any) => <div>{children}</div>,
  SelectValue: () => null,
}))

import { KookSetupWizard, KookDeleteGuildDialog } from '../KookDialogs'

describe('KookDialogs', () => {
  it('KookSetupWizard renders nothing when closed', () => {
    const { container } = render(
      <KookSetupWizard open={false} onOpenChange={vi.fn()} onTokenSave={vi.fn()} existingToken="" />
    )
    expect(container.innerHTML).toBe('')
  })

  it('KookDeleteGuildDialog renders nothing when no confirm', () => {
    const { container } = render(
      <KookDeleteGuildDialog deleteGuildConfirm={null} onClose={vi.fn()} onDelete={vi.fn()} />
    )
    expect(container.innerHTML).toBe('')
  })
})

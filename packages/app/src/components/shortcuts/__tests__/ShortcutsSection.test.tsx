import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => d ?? k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}))
vi.mock('@/stores/shortcuts', () => ({
  useShortcutsStore: Object.assign(
    vi.fn(() => ({
      nodes: [],
      addNode: vi.fn(),
      updateNode: vi.fn(),
      deleteNode: vi.fn(),
      batchMove: vi.fn(),
      getTree: vi.fn(() => []),
      getChildren: vi.fn(() => []),
    })),
    {
      getState: () => ({
        nodes: [],
        getChildren: vi.fn(() => []),
      }),
    }
  ),
  ShortcutNode: {},
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
  Dialog: ({ children }: any) => <div>{children}</div>,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
}))

import { ShortcutsSection } from '../ShortcutsSection'

describe('ShortcutsSection', () => {
  it('renders without crashing', () => {
    const { container } = render(<ShortcutsSection />)
    expect(container).toBeTruthy()
  })
})

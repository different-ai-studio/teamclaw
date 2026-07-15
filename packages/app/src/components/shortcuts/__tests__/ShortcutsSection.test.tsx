import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const storeState = {
  personalNodes: [] as unknown[],
  teamNodes: [] as unknown[],
  addNode: vi.fn().mockResolvedValue('id'),
  updateNode: vi.fn().mockResolvedValue(undefined),
  deleteNode: vi.fn().mockResolvedValue(undefined),
  batchMove: vi.fn().mockResolvedValue(undefined),
  getChildren: vi.fn(() => []),
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => d ?? k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}))
vi.mock('@/stores/shortcuts', () => {
  const useShortcutsStore: any = vi.fn((selector?: (s: typeof storeState) => unknown) => {
    return selector ? selector(storeState) : storeState
  })
  useShortcutsStore.getState = () => storeState
  return {
    useShortcutsStore,
    buildTree: vi.fn(() => []),
    ShortcutNode: {},
  }
})
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
  beforeEach(() => {
    vi.clearAllMocks()
    storeState.personalNodes = []
    storeState.teamNodes = []
    storeState.addNode.mockResolvedValue('id')
    storeState.updateNode.mockResolvedValue(undefined)
    storeState.deleteNode.mockResolvedValue(undefined)
    storeState.batchMove.mockResolvedValue(undefined)
    storeState.getChildren.mockReturnValue([])
  })

  it('renders without crashing', () => {
    const { container } = render(<ShortcutsSection />)
    expect(container).toBeTruthy()
  })

  it('shows a visible error when creating a shortcut fails', async () => {
    storeState.addNode.mockRejectedValue(
      new Error(
        'Could not find the function public.shortcut_create(p_icon, p_label, p_node_type, p_order, p_parent_id, p_scope, p_target, p_team_id) in the schema cache',
      ),
    )
    render(<ShortcutsSection />)

    fireEvent.change(screen.getByPlaceholderText('Enter name'), { target: { value: 'Docs' } })
    fireEvent.change(screen.getByPlaceholderText('https://...'), { target: { value: 'https://example.com' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Shortcut database functions are missing')
    })
  })
})

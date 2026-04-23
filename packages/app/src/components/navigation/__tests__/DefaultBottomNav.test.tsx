import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const uiStoreState = vi.hoisted(() => ({
  defaultNavTab: 'session',
  defaultMoreOpen: false,
  selectDefaultPrimaryTab: vi.fn(),
  setDefaultMoreOpen: vi.fn(),
  openDefaultMoreDestination: vi.fn(),
}))

const workspaceStoreState = vi.hoisted(() => ({
  workspaceName: 'alpha-workspace',
  isLoadingWorkspace: false,
  setWorkspace: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}))

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  isTauri: () => false,
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (state: typeof uiStoreState) => unknown) => selector(uiStoreState),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (state: typeof workspaceStoreState) => unknown) => selector(workspaceStoreState),
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>{children}</button>
  ),
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: any) => <div>{children}</div>,
  PopoverTrigger: ({ children }: any) => <div>{children}</div>,
  PopoverContent: ({ children }: any) => <div>{children}</div>,
}))

import { DefaultBottomNav } from '../DefaultBottomNav'

describe('DefaultBottomNav', () => {
  beforeEach(() => {
    uiStoreState.defaultNavTab = 'session'
    uiStoreState.defaultMoreOpen = false
    uiStoreState.selectDefaultPrimaryTab.mockReset()
    uiStoreState.setDefaultMoreOpen.mockReset()
    uiStoreState.openDefaultMoreDestination.mockReset()
    workspaceStoreState.workspaceName = 'alpha-workspace'
    workspaceStoreState.isLoadingWorkspace = false
    workspaceStoreState.setWorkspace.mockReset()
  })

  it('renders three primary tabs and the more trigger', () => {
    render(<DefaultBottomNav />)

    expect(screen.getByRole('button', { name: /session/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /knowledge/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /shortcuts/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /more/i })).toBeTruthy()
  })

  it('routes primary tab clicks through selectDefaultPrimaryTab', () => {
    render(<DefaultBottomNav />)

    fireEvent.click(screen.getByRole('button', { name: /knowledge/i }))

    expect(uiStoreState.selectDefaultPrimaryTab).toHaveBeenCalledWith('knowledge')
  })

  it('shows the workspace section and routes more destinations through the UI store', () => {
    render(<DefaultBottomNav />)

    expect(screen.getByTestId('default-more-workspace-name').textContent).toBe('alpha-workspace')
    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }))

    expect(uiStoreState.openDefaultMoreDestination).toHaveBeenCalledWith('settings')
    expect(screen.getByRole('button', { name: /switch workspace/i })).toBeTruthy()
  })
})

import * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockInvoke = vi.fn()
const mockRefreshFileTree = vi.fn()
const mockSetAdvancedMode = vi.fn()
const mockAddSuggestion = vi.fn()
const mockRemoveSuggestion = vi.fn()
const mockT = (_key: string, fallback?: string) => fallback ?? _key

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
  }),
}))

vi.mock('i18next', () => ({
  default: {
    language: 'en',
    on: vi.fn(),
    off: vi.fn(),
    changeLanguage: vi.fn(),
  },
}))

vi.mock('@/lib/build-config', () => ({
  appShortName: 'teamclaw',
  buildConfig: {
    app: { shortName: 'teamclaw' },
    defaults: { theme: 'system' },
  },
}))

vi.mock('@/lib/locale', () => ({
  getPreferredLanguage: () => 'en',
  persistLanguage: vi.fn(),
}))

vi.mock('@/lib/permission-policy', () => ({
  getPermissionPolicy: () => 'ask',
  setPermissionPolicy: vi.fn(),
}))

vi.mock('@/stores/suggestions', () => ({
  useSuggestionsStore: (selector: (state: unknown) => unknown) =>
    selector({
      customSuggestions: [],
      addSuggestion: mockAddSuggestion,
      removeSuggestion: mockRemoveSuggestion,
    }),
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (state: unknown) => unknown) =>
    selector({
      advancedMode: false,
      setAdvancedMode: mockSetAdvancedMode,
    }),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) =>
    selector({
      workspacePath: '/tmp/teamclaw-workspace',
      refreshFileTree: mockRefreshFileTree,
    }),
}))

vi.mock('../PermissionBatchSection', () => ({
  PermissionBatchSection: () => <div>Permission Batch Section</div>,
}))

vi.mock('../shared', () => ({
  SettingCard: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  SectionHeader: ({ title }: { title: string }) => <h2>{title}</h2>,
  ToggleSwitch: ({
    enabled,
    onChange,
    disabled,
  }: {
    enabled: boolean
    onChange: (enabled: boolean) => void
    disabled?: boolean
  }) => (
    <button type="button" disabled={disabled} onClick={() => onChange(!enabled)}>
      {enabled ? 'on' : 'off'}
    </button>
  ),
}))

describe('GeneralSection spotlight shortcut setting', () => {
  beforeEach(() => {
    vi.resetModules()
    mockInvoke.mockReset()
    mockInvoke.mockImplementation((command: string, args?: unknown) => {
      if (command === 'get_spotlight_shortcut') {
        return Promise.resolve('alt+space')
      }
      if (command === 'set_spotlight_shortcut') {
        return Promise.resolve((args as { shortcut: string }).shortcut)
      }
      return Promise.resolve(null)
    })

    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    })
  })

  it('loads the current shortcut from Tauri', async () => {
    const { GeneralSection } = await import('../GeneralSection')

    render(<GeneralSection />)

    expect(await screen.findByText('Spotlight Shortcut')).toBeTruthy()
    const shortcutButton = await screen.findByRole('button', { name: /alt\+space/ })
    await waitFor(() => expect((shortcutButton as HTMLButtonElement).disabled).toBe(false))
    expect(mockInvoke).toHaveBeenCalledWith('get_spotlight_shortcut')
  })

  it('captures and saves a changed shortcut through Tauri', async () => {
    const { GeneralSection } = await import('../GeneralSection')

    render(<GeneralSection />)

    const shortcutButton = await screen.findByRole('button', { name: /alt\+space/ })
    await waitFor(() => expect((shortcutButton as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(shortcutButton)
    expect(await screen.findByRole('button', { name: /Press shortcut/ })).toBeTruthy()

    fireEvent.keyDown(window, {
      key: 'P',
      code: 'KeyP',
      metaKey: true,
      shiftKey: true,
    })

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('set_spotlight_shortcut', {
        shortcut: 'cmd+shift+p',
      })
    })
    expect(await screen.findByRole('button', { name: /cmd\+shift\+p/ })).toBeTruthy()
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import { useUIStore } from '../ui'
import { useWorkspaceStore } from '../workspace'

describe('default layout navigation model', () => {
  beforeEach(() => {
    useUIStore.setState({
      currentView: 'chat',
      settingsInitialSection: null,
      embeddedSettingsSection: null,
      defaultNavTab: 'session',
      defaultMoreOpen: false,
    } as Partial<ReturnType<typeof useUIStore.getState>>)

    useWorkspaceStore.setState({
      isPanelOpen: false,
      activeTab: 'shortcuts',
    })
  })

  it('switches to knowledge primary tab without opening settings', () => {
    useUIStore.getState().selectDefaultPrimaryTab('knowledge')

    expect(useUIStore.getState().defaultNavTab).toBe('knowledge')
    expect(useWorkspaceStore.getState().isPanelOpen).toBe(false)
    expect(useUIStore.getState().currentView).toBe('chat')
  })

  it('opens settings from more without changing primary tab', () => {
    useUIStore.setState({
      defaultNavTab: 'shortcuts',
      defaultMoreOpen: true,
    } as Partial<ReturnType<typeof useUIStore.getState>>)

    useUIStore.getState().openDefaultMoreDestination('settings')

    expect(useUIStore.getState().defaultNavTab).toBe('shortcuts')
    expect(useUIStore.getState().currentView).toBe('settings')
    expect(useUIStore.getState().defaultMoreOpen).toBe(false)
  })

  it('opens automation settings from more without changing the selected primary tab', () => {
    useUIStore.setState({
      defaultNavTab: 'knowledge',
      defaultMoreOpen: true,
    } as Partial<ReturnType<typeof useUIStore.getState>>)

    useUIStore.getState().openDefaultMoreDestination('automation')

    expect(useUIStore.getState().defaultNavTab).toBe('knowledge')
    expect(useUIStore.getState().currentView).toBe('settings')
    expect(useUIStore.getState().settingsInitialSection).toBe('automation')
    expect(useUIStore.getState().defaultMoreOpen).toBe(false)
  })
})

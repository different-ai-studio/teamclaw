import { describe, test, expect, beforeEach } from 'vitest'
import {
  useAutomationDefaultModelStore,
  automationDefaultModel,
  automationDefaultForBackends,
} from '@/stores/automation-default-model'

const TEAM = 'team-1'

beforeEach(() => {
  useAutomationDefaultModelStore.setState({ byBackendTeam: {} })
})

describe('automation default model', () => {
  test('round-trips a default per (backend, team)', () => {
    const { setDefault } = useAutomationDefaultModelStore.getState()
    setDefault('pi', TEAM, 'kimi-coding/k3')

    expect(automationDefaultModel('pi', TEAM)).toBe('kimi-coding/k3')
    // Model ids are backend-local, so another backend must not inherit one.
    expect(automationDefaultModel('opencode', TEAM)).toBe('')
    expect(automationDefaultModel('pi', 'team-2')).toBe('')
  })

  test('an empty id clears rather than storing a nameless model', () => {
    const { setDefault } = useAutomationDefaultModelStore.getState()
    setDefault('pi', TEAM, 'kimi-coding/k3')
    setDefault('pi', TEAM, '')

    expect(automationDefaultModel('pi', TEAM)).toBe('')
    expect(useAutomationDefaultModelStore.getState().byBackendTeam).toEqual({})
  })

  test('missing team or backend reads as "no default", never throws', () => {
    const { setDefault } = useAutomationDefaultModelStore.getState()
    setDefault('pi', TEAM, 'kimi-coding/k3')

    expect(automationDefaultModel('', TEAM)).toBe('')
    expect(automationDefaultModel('pi', '')).toBe('')
    expect(automationDefaultModel(null, null)).toBe('')
  })

  test('automationDefaultForBackends finds the default across the offered backends', () => {
    const { setDefault } = useAutomationDefaultModelStore.getState()
    // A device that switched runtimes still holds the old key; the cron dialog
    // asks across whatever its catalog offers rather than re-deriving "the"
    // backend itself.
    setDefault('pi', TEAM, 'kimi-coding/k3')

    expect(automationDefaultForBackends(['opencode', 'pi'], TEAM)).toBe('kimi-coding/k3')
    expect(automationDefaultForBackends(['opencode'], TEAM)).toBe('')
    expect(automationDefaultForBackends([], TEAM)).toBe('')
  })

  test('clearDefault removes only its own key', () => {
    const { setDefault, clearDefault } = useAutomationDefaultModelStore.getState()
    setDefault('pi', TEAM, 'kimi-coding/k3')
    setDefault('pi', 'team-2', 'deepseek/deepseek-v4-pro')

    clearDefault('pi', TEAM)

    expect(automationDefaultModel('pi', TEAM)).toBe('')
    expect(automationDefaultModel('pi', 'team-2')).toBe('deepseek/deepseek-v4-pro')
  })
})

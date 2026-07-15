import { describe, it, expect, beforeEach } from 'vitest'
import { useSetupStore, applyProgress } from '../setup'

describe('setup store progress reducer', () => {
  beforeEach(() => {
    useSetupStore.setState({
      requirements: [
        { id: 'amuxd', title: 'amuxd', optional: false, present: false, version: null },
        { id: 'opencode', title: 'opencode', optional: false, present: false, version: null },
        { id: 'git', title: 'git', optional: true, present: false, version: null },
      ],
      installing: null,
      output: {},
      errors: {},
    })
  })

  it('records running output lines', () => {
    applyProgress({ id: 'opencode', status: 'running', line: 'downloading', error: null })
    expect(useSetupStore.getState().output['opencode']).toContain('downloading')
  })

  it('marks present on done', () => {
    applyProgress({ id: 'amuxd', status: 'done', line: null, error: null })
    const req = useSetupStore.getState().requirements.find((r) => r.id === 'amuxd')!
    expect(req.present).toBe(true)
  })

  it('records error on failed', () => {
    applyProgress({ id: 'opencode', status: 'failed', line: null, error: 'boom' })
    expect(useSetupStore.getState().errors['opencode']).toBe('boom')
  })

  it('requiredSatisfied is true only when all non-optional are present', () => {
    expect(useSetupStore.getState().requiredSatisfied()).toBe(false)
    applyProgress({ id: 'amuxd', status: 'done', line: null, error: null })
    applyProgress({ id: 'opencode', status: 'done', line: null, error: null })
    expect(useSetupStore.getState().requiredSatisfied()).toBe(true)
  })
})

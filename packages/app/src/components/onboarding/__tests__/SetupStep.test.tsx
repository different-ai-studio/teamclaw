import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

import { SetupStep } from '../SetupStep'
import { useSetupStore, type RequirementStatus } from '@/stores/setup'
import { useOnboardingStore } from '@/stores/onboarding'

const req = (id: string, over: Partial<RequirementStatus> = {}): RequirementStatus => ({
  id,
  title: id,
  optional: false,
  present: true,
  version: '1.0.0',
  ...over,
})

function seed(over: Partial<ReturnType<typeof useSetupStore.getState>> = {}) {
  useSetupStore.setState({
    loaded: true,
    installing: null,
    errors: {},
    output: {},
    requirements: [req('amuxd'), req('git', { optional: true })],
    agentRuntimes: [req('opencode', { title: 'OpenCode' }), req('pi', { title: 'Pi' })],
    listRequirements: vi.fn(async () => {}),
    listAgentRuntimes: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    ...over,
  })
}

describe('SetupStep', () => {
  beforeEach(() => {
    seed()
    useOnboardingStore.getState().reset()
  })

  it('lets a developer see both runtimes', () => {
    render(<SetupStep role="developer" onDone={() => {}} />)
    expect(screen.getByText('OpenCode')).toBeInTheDocument()
    expect(screen.getByText('Pi')).toBeInTheDocument()
  })

  // git is optional; only the developer path surfaces it, and even there it
  // must not block continuing.
  it('shows git to developers and hides it from the guided path', () => {
    const { unmount } = render(<SetupStep role="developer" onDone={() => {}} />)
    expect(screen.getByText('git')).toBeInTheDocument()
    unmount()

    seed()
    render(<SetupStep role="guided" onDone={() => {}} />)
    expect(screen.queryByText('git')).not.toBeInTheDocument()
  })

  it('does not block on missing git', () => {
    seed({ requirements: [req('amuxd'), req('git', { optional: true, present: false, version: null })] })
    render(<SetupStep role="developer" onDone={() => {}} />)
    expect(screen.getByRole('button', { name: '继续' })).toBeEnabled()
  })

  // The guided path promises no choices, so it has to land somewhere
  // predictable. Adopting whatever was already installed made the outcome depend
  // on the machine's history: anyone who had ever installed OpenCode got it.
  it('always lands on pi for the guided path, even with another runtime installed', async () => {
    seed({
      agentRuntimes: [
        req('opencode', { title: 'OpenCode' }),
        req('pi', { title: 'Pi', present: false, version: null }),
      ],
    })
    render(<SetupStep role="guided" onDone={() => {}} />)
    await vi.waitFor(() => expect(useOnboardingStore.getState().runtime).toBe('pi'))
  })

  // Landing on pi and then stopping at "install it yourself" would be the same
  // dead end the guided path exists to avoid.
  it('installs pi itself when the guided path finds it missing', async () => {
    const install = vi.fn(async () => {})
    seed({
      agentRuntimes: [
        req('opencode', { title: 'OpenCode' }),
        req('pi', { title: 'Pi', present: false, version: null }),
      ],
      install,
    })
    render(<SetupStep role="guided" onDone={() => {}} />)
    await vi.waitFor(() => expect(install).toHaveBeenCalledWith('pi'))
  })

  // Nothing on the guided screen is user-initiated, so a failed auto-install has
  // no other way to reach the user.
  it('surfaces a runtime install failure on the guided path', () => {
    seed({
      agentRuntimes: [req('opencode', { title: 'OpenCode' }), req('pi', { title: 'Pi' })],
      errors: { pi: 'pi install boom' },
    })
    render(<SetupStep role="guided" onDone={() => {}} />)
    expect(screen.getByText('pi install boom')).toBeInTheDocument()
  })

  it('blocks continuing until amuxd is present', () => {
    seed({ requirements: [req('amuxd', { present: false, version: null })] })
    render(<SetupStep role="developer" onDone={() => {}} />)
    expect(screen.getByRole('button', { name: /继续|正在配置/ })).toBeDisabled()
  })

  it('offers the guided user a way back to choosing a runtime', () => {
    render(<SetupStep role="guided" onDone={() => {}} />)
    screen.getByText('我想自己选运行时').click()
    expect(useOnboardingStore.getState().role).toBe('developer')
  })
})

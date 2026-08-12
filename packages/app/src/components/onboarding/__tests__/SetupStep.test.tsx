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

  // A working install beats a fresh download.
  it('reuses an already-installed runtime on the guided path', async () => {
    seed({
      agentRuntimes: [
        req('opencode', { title: 'OpenCode' }),
        req('pi', { title: 'Pi', present: false, version: null }),
      ],
    })
    render(<SetupStep role="guided" onDone={() => {}} />)
    await vi.waitFor(() => expect(useOnboardingStore.getState().runtime).toBe('opencode'))
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

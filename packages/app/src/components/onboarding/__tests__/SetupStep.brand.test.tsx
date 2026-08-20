import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

// A brand that ships pi. Every build used to open the picker on opencode, so a
// pi brand shipped pi only to the users who noticed the second card — and its
// guided path, which promises no choices at all, installed opencode.
vi.mock('@/lib/build-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/build-config')>()),
  localAgent: 'pi',
}))

import { SetupStep, resolveGuidedRuntime } from '../SetupStep'
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
    requirements: [req('amuxd')],
    agentRuntimes: [req('opencode', { title: 'OpenCode' }), req('pi', { title: 'Pi' })],
    listRequirements: vi.fn(async () => {}),
    listAgentRuntimes: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    ...over,
  })
}

describe('SetupStep on a build that targets pi', () => {
  beforeEach(() => {
    localStorage.clear()
    seed()
    useOnboardingStore.getState().reset()
  })

  it('lands the guided path on the build’s runtime, not opencode', async () => {
    render(<SetupStep role="guided" onDone={() => {}} />)
    await vi.waitFor(() => expect(useOnboardingStore.getState().runtime).toBe('pi'))
  })

  it('installs the build’s runtime when the guided path finds it missing', async () => {
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

  it('opens the developer picker on the build’s runtime', () => {
    render(<SetupStep role="developer" onDone={() => {}} />)
    screen.getByRole('button', { name: '继续' }).click()
    expect(useOnboardingStore.getState().runtime).toBe('pi')
  })

  // The guided path can only land somewhere this app can fetch: cursor and
  // claude-code are the user's own tools, and a guided user has no way to
  // install one from that screen.
  it('falls back to opencode for a build targeting a runtime we cannot install', () => {
    expect(resolveGuidedRuntime('pi')).toBe('pi')
    expect(resolveGuidedRuntime('opencode')).toBe('opencode')
    expect(resolveGuidedRuntime('cursor')).toBe('opencode')
    expect(resolveGuidedRuntime('claude-code')).toBe('opencode')
  })
})

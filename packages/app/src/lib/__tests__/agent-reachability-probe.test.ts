import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockProbeDaemonHttp = vi.fn()
const mockFetchWorkspaces = vi.fn()
const mockWaitForTeamclawRpcReady = vi.fn()

vi.mock('@/lib/daemon-local-client', () => ({
  probeDaemonHttp: (...args: unknown[]) => mockProbeDaemonHttp(...args),
}))

vi.mock('@/lib/teamclaw-rpc', () => ({
  fetchWorkspaces: (...args: unknown[]) => mockFetchWorkspaces(...args),
  waitForTeamclawRpcReady: (...args: unknown[]) => mockWaitForTeamclawRpcReady(...args),
}))

describe('probeAgentReachability', () => {
  beforeEach(() => {
    mockProbeDaemonHttp.mockReset()
    mockFetchWorkspaces.mockReset()
    mockWaitForTeamclawRpcReady.mockReset()
    mockWaitForTeamclawRpcReady.mockResolvedValue(true)
  })

  it('uses HTTP health for the local daemon actor', async () => {
    mockProbeDaemonHttp.mockResolvedValue({ ok: true, baseUrl: 'http://127.0.0.1:1' })
    const { probeAgentReachability } = await import('@/lib/agent-reachability-probe')
    await expect(
      probeAgentReachability({
        agentActorId: 'local-agent',
        localDaemonActorId: 'local-agent',
      }),
    ).resolves.toBe('reachable')
    expect(mockFetchWorkspaces).not.toHaveBeenCalled()
  })

  it('marks local daemon unreachable when HTTP probe fails', async () => {
    mockProbeDaemonHttp.mockResolvedValue({ ok: false, reason: 'not_running' })
    const { probeAgentReachability } = await import('@/lib/agent-reachability-probe')
    await expect(
      probeAgentReachability({
        agentActorId: 'local-agent',
        localDaemonActorId: 'local-agent',
      }),
    ).resolves.toBe('unreachable')
  })

  it('uses short RPC for remote agent actors', async () => {
    mockFetchWorkspaces.mockResolvedValue({ workspaces: [] })
    const { probeAgentReachability } = await import('@/lib/agent-reachability-probe')
    await expect(
      probeAgentReachability({
        agentActorId: 'remote-agent',
        localDaemonActorId: 'local-agent',
      }),
    ).resolves.toBe('reachable')
    expect(mockFetchWorkspaces).toHaveBeenCalledWith({
      targetActorId: 'remote-agent',
      timeoutMs: 3_000,
    })
  })

  it('marks remote agent unreachable when RPC fails', async () => {
    mockFetchWorkspaces.mockRejectedValue(new Error('rpc timeout after 3000ms'))
    const { probeAgentReachability } = await import('@/lib/agent-reachability-probe')
    await expect(
      probeAgentReachability({
        agentActorId: 'old-macpro',
        localDaemonActorId: 'new-local',
      }),
    ).resolves.toBe('unreachable')
  })
})

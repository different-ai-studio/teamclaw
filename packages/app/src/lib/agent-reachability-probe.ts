import { fetchWorkspaces, waitForTeamclawRpcReady } from '@/lib/teamclaw-rpc'
import { probeDaemonHttp } from '@/lib/daemon-local-client'

export type AgentReachability = 'pending' | 'reachable' | 'unreachable'

export const SESSION_AGENT_RPC_PROBE_TIMEOUT_MS = 3_000

/** Probe whether the engaged agent's daemon answers on this machine or over MQTT RPC. */
export async function probeAgentReachability(args: {
  agentActorId: string
  localDaemonActorId: string | null
  rpcTimeoutMs?: number
}): Promise<Exclude<AgentReachability, 'pending'>> {
  const agentId = args.agentActorId.trim()
  const localId = args.localDaemonActorId?.trim() || null
  const rpcTimeoutMs = args.rpcTimeoutMs ?? SESSION_AGENT_RPC_PROBE_TIMEOUT_MS

  if (localId && agentId === localId) {
    const probe = await probeDaemonHttp()
    return probe.ok ? 'reachable' : 'unreachable'
  }

  const rpcReady = await waitForTeamclawRpcReady(Math.min(rpcTimeoutMs, 5_000))
  if (!rpcReady) return 'unreachable'

  try {
    await fetchWorkspaces({ targetActorId: agentId, timeoutMs: rpcTimeoutMs })
    return 'reachable'
  } catch {
    return 'unreachable'
  }
}

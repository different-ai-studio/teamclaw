import { describe, it, expect } from 'vitest'
import { AgentStatus, RuntimeLifecycle } from '@/lib/proto/amux_pb'
import {
  isDriftedLocalGhostBinding,
  resolveAgentPillDot,
  resolveSessionAgentUiState,
} from '@/lib/session-agent-ui-state'

describe('isDriftedLocalGhostBinding', () => {
  it('detects ghost online retain for a superseded local actor', () => {
    expect(
      isDriftedLocalGhostBinding({
        agentId: 'old-macpro',
        localDaemonActorId: 'new-local',
        presenceOnline: true,
        agentRuntimeInfo: undefined,
        agentAvailableModelCount: 0,
        localRuntimeInfo: { state: RuntimeLifecycle.ACTIVE } as never,
        localAvailableModelCount: 2,
      }),
    ).toBe(true)
  })

  it('ignores remote offline agents', () => {
    expect(
      isDriftedLocalGhostBinding({
        agentId: 'remote-agent',
        localDaemonActorId: 'local-agent',
        presenceOnline: false,
        agentRuntimeInfo: undefined,
        agentAvailableModelCount: 0,
        localRuntimeInfo: { state: RuntimeLifecycle.ACTIVE } as never,
        localAvailableModelCount: 2,
      }),
    ).toBe(false)
  })
})

describe('resolveSessionAgentUiState', () => {
  it('returns stale when binding superseded', () => {
    expect(
      resolveSessionAgentUiState({
        presenceOnline: true,
        runtimeInfo: undefined,
        availableModelCount: 0,
        isStaleBinding: true,
        connectingTimedOut: false,
      }),
    ).toBe('stale')
  })

  it('returns offline when presence is false', () => {
    expect(
      resolveSessionAgentUiState({
        presenceOnline: false,
        runtimeInfo: undefined,
        availableModelCount: 0,
        isStaleBinding: false,
        connectingTimedOut: false,
      }),
    ).toBe('offline')
  })

  it('returns ready when online with models and active runtime', () => {
    expect(
      resolveSessionAgentUiState({
        presenceOnline: true,
        runtimeInfo: { state: RuntimeLifecycle.ACTIVE } as never,
        availableModelCount: 2,
        isStaleBinding: false,
        connectingTimedOut: false,
      }),
    ).toBe('ready')
  })

  it('returns offline when presence is false despite active runtime retain', () => {
    expect(
      resolveSessionAgentUiState({
        presenceOnline: false,
        runtimeInfo: { state: RuntimeLifecycle.ACTIVE } as never,
        availableModelCount: 2,
        isStaleBinding: false,
        connectingTimedOut: false,
      }),
    ).toBe('offline')
  })

  it('returns ready when an active stream confirms the agent is replying despite stale offline presence', () => {
    expect(
      resolveSessionAgentUiState({
        presenceOnline: false,
        runtimeInfo: { state: RuntimeLifecycle.ACTIVE } as never,
        availableModelCount: 0,
        isStaleBinding: false,
        connectingTimedOut: false,
        activeStreamConfirmed: true,
      }),
    ).toBe('ready')
  })

  it('returns offline when reachability probe fails despite active runtime retain', () => {
    expect(
      resolveSessionAgentUiState({
        presenceOnline: true,
        runtimeInfo: { state: RuntimeLifecycle.ACTIVE } as never,
        availableModelCount: 2,
        isStaleBinding: false,
        connectingTimedOut: false,
        reachabilityFailed: true,
      }),
    ).toBe('offline')
  })

  it('returns offline after connecting timeout', () => {
    expect(
      resolveSessionAgentUiState({
        presenceOnline: undefined,
        runtimeInfo: undefined,
        availableModelCount: 0,
        isStaleBinding: false,
        connectingTimedOut: true,
      }),
    ).toBe('offline')
  })

  it('returns offline when reachability probe fails', () => {
    expect(
      resolveSessionAgentUiState({
        presenceOnline: true,
        runtimeInfo: undefined,
        availableModelCount: 0,
        isStaleBinding: false,
        connectingTimedOut: false,
        reachabilityFailed: true,
      }),
    ).toBe('offline')
  })

  it('returns offline when online presence ghost times out without runtime', () => {
    expect(
      resolveSessionAgentUiState({
        presenceOnline: true,
        runtimeInfo: undefined,
        availableModelCount: 0,
        isStaleBinding: false,
        connectingTimedOut: true,
      }),
    ).toBe('offline')
  })

  describe('local agent fast path', () => {
    // The whole point: a healthy local daemon answering over loopback must not
    // sit at 连接中 waiting for an MQTT retain that may be seconds away — or,
    // on a fresh install, may never come at all.

    it('is ready from the loopback catalog alone, with no retain', () => {
      expect(
        resolveSessionAgentUiState({
          presenceOnline: undefined,
          runtimeInfo: undefined,
          availableModelCount: 0,
          isStaleBinding: false,
          connectingTimedOut: false,
          localReachabilityConfirmed: true,
          localCatalog: 'ready',
        }),
      ).toBe('ready')
    })

    it('is ready on loopback models even while the runtime still reports STARTING', () => {
      expect(
        resolveSessionAgentUiState({
          presenceOnline: true,
          runtimeInfo: { state: RuntimeLifecycle.STARTING } as never,
          availableModelCount: 3,
          isStaleBinding: false,
          connectingTimedOut: false,
          localReachabilityConfirmed: true,
          localCatalog: 'ready',
        }),
      ).toBe('ready')
    })

    it('reports unconfigured — not connecting — when the daemon has no models', () => {
      // First install: the daemon is up and answering, it simply has no
      // provider configured. Terminal, so "Connecting…" would be a lie.
      expect(
        resolveSessionAgentUiState({
          presenceOnline: true,
          runtimeInfo: undefined,
          availableModelCount: 0,
          isStaleBinding: false,
          connectingTimedOut: false,
          localReachabilityConfirmed: true,
          localCatalog: 'empty',
        }),
      ).toBe('unconfigured')
    })

    // "Could not ask" and "has nothing" arrive as the same empty list from the
    // daemon unless probe_error separates them. Reporting a rejected API key as
    // "No model configured" sends the user hunting for a missing provider.
    it('separates a failed probe from a genuinely empty catalog', () => {
      const base = {
        presenceOnline: true,
        runtimeInfo: undefined,
        availableModelCount: 0,
        isStaleBinding: false,
        connectingTimedOut: false,
        localReachabilityConfirmed: true,
      } as const

      expect(resolveSessionAgentUiState({ ...base, localCatalog: 'empty' })).toBe(
        'unconfigured',
      )
      expect(resolveSessionAgentUiState({ ...base, localCatalog: 'error' })).toBe(
        'catalog-error',
      )
    })

    it('still shows connecting while the loopback probe is in flight', () => {
      expect(
        resolveSessionAgentUiState({
          presenceOnline: true,
          runtimeInfo: undefined,
          availableModelCount: 0,
          isStaleBinding: false,
          connectingTimedOut: false,
          localReachabilityConfirmed: true,
          localCatalog: 'pending',
        }),
      ).toBe('connecting')
    })

    it('lets a stale binding and a failed probe still win over the fast path', () => {
      expect(
        resolveSessionAgentUiState({
          presenceOnline: true,
          runtimeInfo: undefined,
          availableModelCount: 0,
          isStaleBinding: true,
          connectingTimedOut: false,
          localReachabilityConfirmed: true,
          localCatalog: 'ready',
        }),
      ).toBe('stale')

      expect(
        resolveSessionAgentUiState({
          presenceOnline: true,
          runtimeInfo: undefined,
          availableModelCount: 0,
          isStaleBinding: false,
          connectingTimedOut: false,
          reachabilityFailed: true,
          localReachabilityConfirmed: true,
          localCatalog: 'ready',
        }),
      ).toBe('offline')
    })
  })

  describe('remote agents are untouched by the local fast path', () => {
    // Loopback HTTP reaches this machine only. A remote agent must resolve
    // purely from presence + retain, exactly as before.

    it('keeps connecting for an online remote agent with no models', () => {
      expect(
        resolveSessionAgentUiState({
          presenceOnline: true,
          runtimeInfo: { state: RuntimeLifecycle.STARTING } as never,
          availableModelCount: 0,
          isStaleBinding: false,
          connectingTimedOut: false,
          // No localReachabilityConfirmed — this is someone else's machine.
        }),
      ).toBe('connecting')
    })

    it('never reports unconfigured for a remote agent', () => {
      // Even if a catalog snapshot leaked in, without loopback confirmation it
      // must not be allowed to describe another device.
      expect(
        resolveSessionAgentUiState({
          presenceOnline: true,
          runtimeInfo: undefined,
          availableModelCount: 0,
          isStaleBinding: false,
          connectingTimedOut: false,
          localCatalog: 'empty',
        }),
      ).toBe('connecting')
    })

    it('does not turn a remote agent ready on this device’s catalog', () => {
      expect(
        resolveSessionAgentUiState({
          presenceOnline: true,
          runtimeInfo: undefined,
          availableModelCount: 0,
          isStaleBinding: false,
          connectingTimedOut: false,
          localCatalog: 'ready',
        }),
      ).toBe('connecting')
    })
  })
})

describe('resolveAgentPillDot', () => {
  const GRAY = 'bg-muted-foreground/40'
  const GREEN = 'bg-emerald-500'
  const AMBER = 'bg-amber-400'
  const RED = 'bg-red-500'

  describe('local agent — ready via the loopback fast path, no retain', () => {
    it('is green, not gray, when ready with no runtime info at all', () => {
      // The regression this guards: `resolveSessionAgentUiState`'s local fast
      // path returns 'ready' off the loopback catalog alone, so the local agent
      // is the ONLY agent that can be ready with no MQTT retain. Reading the
      // absent retain here painted a gray dot on a pill that was at the same
      // time showing a model name, no status suffix, and a live model picker.
      expect(resolveAgentPillDot('ready', undefined).color).toBe(GREEN)
    })

    it('does not pulse in that state — nothing is in progress', () => {
      expect(resolveAgentPillDot('ready', undefined).pulse).toBe(false)
    })
  })

  describe('retain present — the finer-grained answer wins', () => {
    it('green for an active runtime', () => {
      expect(
        resolveAgentPillDot('ready', {
          state: RuntimeLifecycle.ACTIVE,
          status: AgentStatus.IDLE,
        } as never).color,
      ).toBe(GREEN)
    })

    it('amber while starting, even though uiState already says ready', () => {
      expect(
        resolveAgentPillDot('ready', { state: RuntimeLifecycle.STARTING } as never).color,
      ).toBe(AMBER)
    })

    it('red for a failed runtime', () => {
      expect(
        resolveAgentPillDot('ready', { state: RuntimeLifecycle.FAILED } as never).color,
      ).toBe(RED)
    })

    it('red for an active runtime reporting an agent error', () => {
      expect(
        resolveAgentPillDot('ready', {
          state: RuntimeLifecycle.ACTIVE,
          status: AgentStatus.ERROR,
        } as never).color,
      ).toBe(RED)
    })

    it('gray for a stopped runtime', () => {
      expect(
        resolveAgentPillDot('ready', { state: RuntimeLifecycle.STOPPED } as never).color,
      ).toBe(GRAY)
    })

    it('gray for an unknown lifecycle', () => {
      expect(
        resolveAgentPillDot('ready', { state: RuntimeLifecycle.UNKNOWN } as never).color,
      ).toBe(GRAY)
    })
  })

  describe('non-ready states ignore the retain entirely', () => {
    it('offline is gray even with an ACTIVE retain (a ghost the uiState vetoed)', () => {
      expect(
        resolveAgentPillDot('offline', {
          state: RuntimeLifecycle.ACTIVE,
          status: AgentStatus.IDLE,
        } as never).color,
      ).toBe(GRAY)
    })

    it('stale is red even with an ACTIVE retain', () => {
      expect(
        resolveAgentPillDot('stale', {
          state: RuntimeLifecycle.ACTIVE,
          status: AgentStatus.IDLE,
        } as never).color,
      ).toBe(RED)
    })

    it('connecting is amber', () => {
      expect(resolveAgentPillDot('connecting', undefined).color).toBe(AMBER)
    })

    it('a failed model probe is red — broken, not merely unset', () => {
      expect(resolveAgentPillDot('catalog-error', undefined).color).not.toBe(AMBER)
    })

    it('unconfigured is amber — a setup gap, not a failure', () => {
      expect(resolveAgentPillDot('unconfigured', undefined).color).toBe(AMBER)
    })
  })

  it('agrees with the pill for every state a remote agent can reach', () => {
    // A remote agent only reaches 'ready' through the ACTIVE branch of
    // resolveSessionAgentUiState, so ready-without-retain is unreachable for it
    // and this change cannot alter any remote dot.
    const remoteReady = resolveSessionAgentUiState({
      presenceOnline: true,
      runtimeInfo: { state: RuntimeLifecycle.ACTIVE, status: AgentStatus.IDLE } as never,
      availableModelCount: 3,
      isStaleBinding: false,
      connectingTimedOut: false,
    })
    expect(remoteReady).toBe('ready')
    expect(
      resolveAgentPillDot(remoteReady, {
        state: RuntimeLifecycle.ACTIVE,
        status: AgentStatus.IDLE,
      } as never).color,
    ).toBe(GREEN)
  })
})

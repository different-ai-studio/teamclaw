export type SharedModuleLease = {
  ownerId: string
  ready: Promise<void>
  release: () => void
}

type SetupControls = {
  isCurrent: () => boolean
  setCleanup: (cleanup: () => void) => void
}

type Slot<Context> = {
  key: string
  context: Context
  owners: Set<string>
  cleanup: (() => void) | null
  ready: Promise<void>
  isReady: boolean
  failed: boolean
  attemptActive: boolean
}

/**
 * Owns one async module setup while allowing overlapping React effects to
 * share it safely. A lease exists before setup awaits, so cleanup can revoke
 * an in-flight generation without waiting for SUBACK/listener registration.
 */
export function createSharedModuleLeaseManager<Context>(options: {
  key: (context: Context) => string
  setup: (context: Context, controls: SetupControls) => Promise<void>
  onDeactivate?: (context: Context) => void
  retryDelaysMs?: readonly number[]
}) {
  let slot: Slot<Context> | null = null

  const deactivateAttempt = (target: Slot<Context>) => {
    if (!target.attemptActive) return
    target.attemptActive = false
    target.cleanup?.()
    target.cleanup = null
    options.onDeactivate?.(target.context)
  }

  const deactivate = (target: Slot<Context>) => {
    if (slot === target) slot = null
    target.isReady = false
    deactivateAttempt(target)
  }

  const acquire = (context: Context, ownerId: string): SharedModuleLease => {
    const key = options.key(context)
    if (!key || !ownerId.trim()) throw new Error('module lease requires context and ownerId')

    if (slot && slot.key === key && !slot.failed) {
      const target = slot
      if (target.owners.has(ownerId)) {
        throw new Error(`module lease owner already acquired: ${ownerId}`)
      }
      target.owners.add(ownerId)
      let released = false
      return {
        ownerId,
        ready: target.ready,
        release: () => {
          if (released) return
          released = true
          if (slot !== target) return
          target.owners.delete(ownerId)
          if (target.owners.size === 0) deactivate(target)
        },
      }
    }

    if (slot) deactivate(slot)

    const target: Slot<Context> = {
      key,
      context,
      owners: new Set([ownerId]),
      cleanup: null,
      ready: Promise.resolve(),
      isReady: false,
      failed: false,
      attemptActive: false,
    }
    slot = target

    const controls: SetupControls = {
      isCurrent: () => slot === target && target.owners.size > 0,
      setCleanup: (cleanup) => {
        if (!controls.isCurrent()) {
          cleanup()
          return
        }
        target.cleanup?.()
        target.cleanup = cleanup
      },
    }

    const retryDelaysMs = options.retryDelaysMs ?? [250, 1_000, 3_000]
    const waitForRetry = (delayMs: number) => new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs)
    })
    const runSetup = async (attempt: number): Promise<void> => {
      if (!controls.isCurrent()) return
      target.attemptActive = true
      try {
        // The first call is made before acquire returns, so setup can establish
        // cheap identity/context synchronously up to its first await.
        await options.setup(context, controls)
        if (!controls.isCurrent()) return
        target.failed = false
        target.isReady = true
      } catch (error) {
        if (!controls.isCurrent()) return
        target.isReady = false
        deactivateAttempt(target)
        const delayMs = retryDelaysMs[attempt]
        if (delayMs === undefined) {
          target.failed = true
          throw error
        }
        await waitForRetry(delayMs)
        if (!controls.isCurrent()) return
        await runSetup(attempt + 1)
      }
    }
    target.ready = runSetup(0)

    let released = false
    return {
      ownerId,
      ready: target.ready,
      release: () => {
        if (released) return
        released = true
        if (slot !== target) return
        target.owners.delete(ownerId)
        if (target.owners.size === 0) deactivate(target)
      },
    }
  }

  return {
    acquire,
    isReady: () => slot?.isReady === true,
    activeKey: () => slot?.key ?? null,
    ownerCount: () => slot?.owners.size ?? 0,
  }
}

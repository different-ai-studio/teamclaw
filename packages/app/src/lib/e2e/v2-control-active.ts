/**
 * The "is the E2E harness driving this app?" flag, split out from
 * `v2-control.ts` so production builds do not carry the control surface.
 *
 * `v2-control.ts` is ~30KB of test-only code that can seed sessions, actors
 * and messages straight into the stores. Several hot paths need to ask whether
 * it is active, and they need the answer synchronously — so they cannot simply
 * `await import()` it. Keeping the flag here lets those call sites import
 * something tiny while the control itself loads dynamically, and only in a
 * build that asked for it.
 *
 * `E2E_BUILD` is a module-level const on purpose: `vite.config.ts` defines
 * `import.meta.env.VITE_TEAMCLU_E2E` to a literal, so in a normal build this
 * folds to `false` and the bundler drops both the dynamic import in `App.tsx`
 * and everything behind it.
 */
export const E2E_BUILD = import.meta.env.VITE_TEAMCLU_E2E === 'true'

let controlInstalled = false
let controlActive = false

/**
 * True only while the harness has installed the control *and* seeded state
 * into it. Callers use this to skip the normal network/cache loading paths so
 * seeded fixtures are not overwritten.
 */
export function isV2E2EControlActive(): boolean {
  return E2E_BUILD && typeof window !== 'undefined' && controlInstalled && controlActive
}

/** @internal called by `installV2E2EControl` */
export function markV2E2EControlInstalled(): void {
  controlInstalled = true
}

/** @internal driven by the control's seed/reset methods */
export function setV2E2EControlActive(active: boolean): void {
  controlActive = active
}

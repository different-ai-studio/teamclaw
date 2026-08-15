import { firstAvailableRecentModel } from '@/lib/local-daemon-model-catalog'

/**
 * One-time backfill of `payload.model` on cron jobs saved before the field was
 * required (ADR-0007, migration plan P2).
 *
 * # Why this has a deadline
 *
 * A job with no model used to resolve at run time against the device MRU
 * (`config::model_mru`). That MRU is deleted in P5, so these jobs have exactly
 * one window in which the intended answer is still knowable — between the field
 * becoming required and the MRU going away. After P5 the only remaining option
 * is to fail the run and make the user pick.
 *
 * # Why it refuses more often than it acts
 *
 * The value written here becomes the job's permanent pinned model, so writing a
 * wrong one is worse than writing none: the job keeps running either way, but a
 * wrong pin is silent and a missing pin is fixable. Every input therefore has to
 * be positively known — an MRU entry that the live catalog no longer offers is
 * treated as no answer at all, exactly as `model_mru::first_available` does.
 */

/** Minimal shape needed to decide; matches `CronJob` structurally. */
export interface BackfillCandidate {
  id: string
  payload: { model?: string }
}

export interface CronModelBackfillPlan {
  /** Jobs to rewrite, with the model each should be pinned to. */
  updates: { id: string; model: string }[]
  /**
   * Whether the run is conclusive — i.e. every job that needed a model got one.
   * `false` means the caller must NOT mark the backfill done: the catalog or the
   * MRU was unavailable, and a later launch may still be able to answer.
   */
  complete: boolean
}

/**
 * Decide which jobs to backfill and to what.
 *
 * `recentModels` is this device's MRU newest-first (from the loopback catalog's
 * `recent_models`); `available` is the live catalog for the same workspace. A
 * remembered model the catalog no longer serves is skipped rather than pinned.
 */
export function planCronModelBackfill(args: {
  jobs: readonly BackfillCandidate[]
  recentModels: string[] | undefined
  available: readonly { id?: string }[]
}): CronModelBackfillPlan {
  const needing = args.jobs.filter((job) => !job.payload.model?.trim())
  if (needing.length === 0) {
    // Nothing to do is a conclusive answer: the backfill is done for good.
    return { updates: [], complete: true }
  }

  const model = firstAvailableRecentModel(args.recentModels, args.available)
  if (!model) {
    // Either the daemon never answered (catalog empty) or nothing the MRU
    // remembers is still on offer. Both mean "ask again next launch" — not
    // "these jobs have no model".
    return { updates: [], complete: false }
  }

  return {
    updates: needing.map((job) => ({ id: job.id, model })),
    complete: true,
  }
}

import { describe, it, expect } from 'vitest'
import { planCronModelBackfill } from '@/lib/cron-model-backfill'

const CATALOG = [{ id: 'anthropic/claude-sonnet-4-6' }, { id: 'openai/gpt-5' }]

describe('planCronModelBackfill', () => {
  it('pins the MRU head onto jobs that have no model', () => {
    const plan = planCronModelBackfill({
      jobs: [
        { id: 'a', payload: {} },
        { id: 'b', payload: { model: '  ' } },
      ],
      recentModels: ['openai/gpt-5', 'anthropic/claude-sonnet-4-6'],
      available: CATALOG,
    })
    expect(plan.updates).toEqual([
      { id: 'a', model: 'openai/gpt-5' },
      { id: 'b', model: 'openai/gpt-5' },
    ])
    expect(plan.complete).toBe(true)
  })

  it('leaves jobs that already pinned a model alone', () => {
    const plan = planCronModelBackfill({
      jobs: [{ id: 'a', payload: { model: 'openai/gpt-5' } }],
      recentModels: ['anthropic/claude-sonnet-4-6'],
      available: CATALOG,
    })
    expect(plan.updates).toEqual([])
    expect(plan.complete).toBe(true)
  })

  it('skips an MRU entry the catalog no longer offers', () => {
    // A wrong pin is permanent and silent; a missing pin is fixable. So a
    // remembered model that is no longer served is treated as no answer.
    const plan = planCronModelBackfill({
      jobs: [{ id: 'a', payload: {} }],
      recentModels: ['retired/model'],
      available: CATALOG,
    })
    expect(plan.updates).toEqual([])
    expect(plan.complete).toBe(false)
  })

  it('is inconclusive when the catalog has not arrived', () => {
    // Daemon down or still starting. Must not be recorded as done — the next
    // launch may still be able to answer, and after P5 nothing can.
    const plan = planCronModelBackfill({
      jobs: [{ id: 'a', payload: {} }],
      recentModels: ['openai/gpt-5'],
      available: [],
    })
    expect(plan.updates).toEqual([])
    expect(plan.complete).toBe(false)
  })

  it('is inconclusive when this device has no MRU at all', () => {
    const plan = planCronModelBackfill({
      jobs: [{ id: 'a', payload: {} }],
      recentModels: [],
      available: CATALOG,
    })
    expect(plan.updates).toEqual([])
    expect(plan.complete).toBe(false)
  })

  it('is conclusively done when nothing needs a model, even with no MRU', () => {
    const plan = planCronModelBackfill({
      jobs: [{ id: 'a', payload: { model: 'openai/gpt-5' } }],
      recentModels: undefined,
      available: [],
    })
    expect(plan.complete).toBe(true)
  })
})

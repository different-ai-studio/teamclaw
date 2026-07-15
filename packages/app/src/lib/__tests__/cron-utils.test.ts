import { describe, expect, it } from 'vitest'

import { defaultFormState, formStateToPayload, jobToFormState } from '../cron-utils'
import type { CronJob } from '@/stores/cron'

describe('cron-utils timeout compatibility', () => {
  it('does not write timeoutSeconds into new or edited job payloads', () => {
    const payload = formStateToPayload({
      ...defaultFormState,
      message: 'run the report',
    })

    expect(payload).toEqual({ message: 'run the report' })
    expect('timeoutSeconds' in payload).toBe(false)
  })

  it('loads legacy jobs with timeoutSeconds without exposing timeout form state', () => {
    const now = new Date().toISOString()
    const job: CronJob = {
      id: 'job-1',
      name: 'Legacy job',
      enabled: true,
      schedule: { kind: 'every', everyMs: 30 * 60 * 1000 },
      payload: {
        message: 'legacy',
        timeoutSeconds: 30,
      },
      deleteAfterRun: false,
      createdAt: now,
      updatedAt: now,
    }

    const form = jobToFormState(job)

    expect(form.message).toBe('legacy')
    expect('timeoutSeconds' in form).toBe(false)
  })
})

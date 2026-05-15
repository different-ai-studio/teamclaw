import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase-client', () => {
  const insert = vi.fn().mockResolvedValue({ data: null, error: null })
  const from = vi.fn().mockReturnValue({ insert })
  return { supabase: { from }, __mocks: { from, insert } }
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabaseMock = (await import('@/lib/supabase-client')) as any

import { insertFeedback } from '@/lib/telemetry/supabase-feedback'

describe('insertFeedback', () => {
  beforeEach(() => {
    supabaseMock.__mocks.from.mockClear()
    supabaseMock.__mocks.insert.mockClear()
  })

  it('writes one row to actor_message_feedback with kind=positive', async () => {
    await insertFeedback({
      actorId: 'a-1', teamId: 't-1', sessionId: 's-1',
      messageId: 'm-1', kind: 'positive', skill: 'editor',
    })
    expect(supabaseMock.__mocks.from).toHaveBeenCalledWith('actor_message_feedback')
    expect(supabaseMock.__mocks.insert).toHaveBeenCalledWith({
      actor_id: 'a-1', team_id: 't-1', session_id: 's-1',
      message_id: 'm-1', kind: 'positive', star_rating: null, skill: 'editor',
    })
  })
})

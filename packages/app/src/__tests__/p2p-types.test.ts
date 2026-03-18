import { P2P_SYNC_STATUSES, isP2pConfig } from '../lib/git/types'

describe('P2P Type Definitions', () => {
  test('P2pConfig validated by type guard', () => {
    const config = {
      enabled: true,
      tickets: [],
      publishEnabled: false,
      lastSyncAt: null,
    }

    expect(isP2pConfig(config)).toBe(true)
  })

  test('isP2pConfig rejects invalid objects', () => {
    expect(isP2pConfig({})).toBe(false)
    expect(isP2pConfig({ enabled: true })).toBe(false)
    expect(isP2pConfig(null)).toBe(false)
  })

  test('P2pConfig with tickets array validates correctly', () => {
    const config = {
      enabled: true,
      tickets: [
        {
          ticket: 'blob1234abcd',
          label: 'Team Alpha',
          addedAt: '2024-01-15T10:00:00Z',
        },
      ],
      publishEnabled: true,
      lastSyncAt: '2024-01-15T10:30:00Z',
    }

    expect(isP2pConfig(config)).toBe(true)
    expect(config.tickets).toHaveLength(1)
    expect(config.tickets[0].ticket).toBe('blob1234abcd')
    expect(config.tickets[0].label).toBe('Team Alpha')
  })

  test('P2P_SYNC_STATUSES contains expected values', () => {
    expect(P2P_SYNC_STATUSES).toContain('idle')
    expect(P2P_SYNC_STATUSES).toContain('syncing')
    expect(P2P_SYNC_STATUSES).toContain('synced')
    expect(P2P_SYNC_STATUSES).toContain('error')
    expect(P2P_SYNC_STATUSES).toHaveLength(4)
  })
})

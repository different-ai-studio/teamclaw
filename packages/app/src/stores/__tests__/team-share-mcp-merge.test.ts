import { describe, expect, test } from 'vitest'
import type { TeamMcpServer } from '@/lib/backend/cloud-api/team-mcp'
import { mergeTeamMcpCatalogAndDaemon } from '../team-share-browser'

const catalogEntry = (installed: boolean): TeamMcpServer => ({
  id: 'server-1',
  teamId: 'team-1',
  name: 'weather',
  description: null,
  transport: 'stdio',
  command: 'weather-mcp',
  args: [],
  url: null,
  env: {},
  headers: {},
  createdBy: 'human-actor',
  updatedBy: 'human-actor',
  createdAt: '2026-08-14T00:00:00Z',
  updatedAt: '2026-08-14T00:00:00Z',
  installed,
})

describe('mergeTeamMcpCatalogAndDaemon', () => {
  test('ignores an installation belonging to the desktop user actor', () => {
    const [item] = mergeTeamMcpCatalogAndDaemon([catalogEntry(true)], {})
    expect(item.installed).toBe(false)
  })

  test('marks a server installed only when it is live in the daemon team config', () => {
    const [item] = mergeTeamMcpCatalogAndDaemon([catalogEntry(false)], {
      weather: { source: 'team', type: 'local', command: ['weather-mcp'] },
    })
    expect(item.installed).toBe(true)
    expect(item.config.command).toEqual(['weather-mcp'])
  })
})

import { describe, expect, it } from 'vitest'
import type { TeamMcpServer } from '@/lib/backend/types'
import type { DaemonMcpServerConfig } from '@/lib/daemon-local-client'
import { planMcpItems } from '../team-share-browser'

const catalogEntry = (installed: boolean): TeamMcpServer => ({
  name: 'memory',
  description: null,
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-memory'],
  url: null,
  headers: null,
  env: null,
  installed,
  createdAt: null,
  updatedAt: null,
})

const workspaceOverride: DaemonMcpServerConfig = {
  source: 'workspace',
  type: 'local',
  enabled: true,
  command: ['node', './personal-memory.js'],
  environment: {},
  headers: {},
}

describe('planMcpItems', () => {
  it('does not treat a colliding personal override as a team installation', () => {
    const rows = planMcpItems([catalogEntry(false)], { memory: workspaceOverride })

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      id: 'memory',
      name: 'memory',
      kind: 'team-available',
      installed: false,
      config: { source: 'team', command: ['npx', '-y', '@modelcontextprotocol/server-memory'] },
    })
    expect(rows[1]).toMatchObject({
      id: 'personal:memory',
      name: 'memory',
      kind: 'personal',
      installed: true,
      config: workspaceOverride,
    })
  })

  it('keeps an installed team row separate from a colliding personal override', () => {
    const rows = planMcpItems([catalogEntry(true)], { memory: workspaceOverride })

    expect(rows.map((row) => [row.id, row.kind])).toEqual([
      ['memory', 'team-installed'],
      ['personal:memory', 'personal'],
    ])
  })
})

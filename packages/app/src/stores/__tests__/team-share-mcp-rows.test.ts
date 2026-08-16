import { describe, expect, it } from 'vitest'
import type { TeamMcpServer } from '@/lib/backend/types'
import type { DaemonMcpServerConfig, DaemonMcpServerProbeResult } from '@/lib/daemon-local-client'
import { applyMcpProbes, planMcpItems } from '../team-share-browser'

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

describe('applyMcpProbes', () => {
  const readyProbe: DaemonMcpServerProbeResult = {
    probe_status: 'ready',
    tools: ['remember'],
    error: null,
    probed_at: '2026-08-16T00:00:00Z',
  }

  it('attributes a same-name runtime probe only to the effective personal override', () => {
    const rows = planMcpItems([catalogEntry(true)], { memory: workspaceOverride })

    const probed = applyMcpProbes(rows, { memory: readyProbe })

    expect(probed.find((row) => row.id === 'memory')).toMatchObject({
      probeStatus: 'unknown',
      tools: [],
      error: null,
    })
    expect(probed.find((row) => row.id === 'personal:memory')).toMatchObject({
      probeStatus: 'ready',
      tools: ['remember'],
      error: null,
    })
  })

  it('attributes a probe to an unshadowed team row', () => {
    const rows = planMcpItems([catalogEntry(true)], {})

    expect(applyMcpProbes(rows, { memory: readyProbe })[0]).toMatchObject({
      id: 'memory',
      probeStatus: 'ready',
      tools: ['remember'],
    })
  })
})

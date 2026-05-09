import { describe, expect, it } from 'vitest'

import {
  evaluateProductionGuard,
  extractPermissionCommand,
  type ProductionGuardConfig,
} from '../dangerous-command-policy'

describe('dangerous-command-policy', () => {
  const config: ProductionGuardConfig = {
    version: 1,
    enabled: true,
    rules: [
      {
        id: 'sync-prod-orders',
        label: 'Sync production orders',
        match: {
          commandIncludes: ['scripts/sync-prod-orders.ts', 'pnpm sync-prod-orders'],
        },
        risk: 'production_data',
        approval: {
          mode: 'always_ask',
          allowAlways: false,
        },
      },
    ],
  }

  it('extracts command text from permission metadata before patterns', () => {
    expect(
      extractPermissionCommand({
        id: 'perm-1',
        sessionID: 'session-1',
        permission: 'bash',
        patterns: ['fallback command'],
        metadata: { command: 'pnpm sync-prod-orders' },
      }),
    ).toBe('pnpm sync-prod-orders')
  })

  it('marks configured production scripts as production data risk', () => {
    const risk = evaluateProductionGuard('pnpm sync-prod-orders --limit 10', config)

    expect(risk).toMatchObject({
      level: 'production_data',
      matchedRules: ['sync-prod-orders'],
      allowAlways: false,
    })
    if (risk.level === 'production_data') {
      expect(risk.reasons.join(' ')).toContain('Sync production orders')
    }
  })

  it('does not flag unrelated commands', () => {
    expect(evaluateProductionGuard('pnpm test', config)).toEqual({ level: 'normal' })
  })

  it('ignores rules when the guard is disabled', () => {
    expect(evaluateProductionGuard('pnpm sync-prod-orders', { ...config, enabled: false })).toEqual({
      level: 'normal',
    })
  })
})

import { describe, it, expect } from 'vitest'
import {
  isTeamMember,
  isP2pConfig,
  type TeamMember,
  type DeviceInfo,
  type P2pConfig,
} from '@/lib/git/types'

describe('P2P Allowlist Types', () => {
  describe('isTeamMember', () => {
    it('validates correct TeamMember shape', () => {
      const member: TeamMember = {
        nodeId: 'abc123',
        label: 'Dev Machine',
        platform: 'macos',
        arch: 'aarch64',
        hostname: 'macbook-pro',
        addedAt: '2026-01-01T00:00:00Z',
      }
      expect(isTeamMember(member)).toBe(true)
    })

    it('rejects invalid objects', () => {
      expect(isTeamMember(null)).toBe(false)
      expect(isTeamMember({})).toBe(false)
      expect(isTeamMember({ nodeId: 123 })).toBe(false)
    })
  })

  describe('isP2pConfig with allowlist fields', () => {
    it('validates P2pConfig with ownerNodeId and allowedMembers', () => {
      const config: P2pConfig = {
        enabled: true,
        tickets: [],
        publishEnabled: true,
        lastSyncAt: null,
        ownerNodeId: 'owner-123',
        allowedMembers: [
          {
            nodeId: 'owner-123',
            label: 'Owner',
            platform: 'macos',
            arch: 'aarch64',
            hostname: 'mac',
            addedAt: '2026-01-01T00:00:00Z',
          },
        ],
      }
      expect(isP2pConfig(config)).toBe(true)
    })

    it('validates P2pConfig without optional allowlist fields', () => {
      const config: P2pConfig = {
        enabled: false,
        tickets: [],
        publishEnabled: false,
        lastSyncAt: null,
      }
      expect(isP2pConfig(config)).toBe(true)
    })
  })

  describe('DeviceInfo type', () => {
    it('has correct shape', () => {
      const info: DeviceInfo = {
        nodeId: 'abc123',
        platform: 'macos',
        arch: 'aarch64',
        hostname: 'macbook-pro',
      }
      expect(info.nodeId).toBe('abc123')
      expect(info.platform).toBe('macos')
      expect(info.arch).toBe('aarch64')
      expect(info.hostname).toBe('macbook-pro')
    })
  })
})

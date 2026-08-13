import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockExists = vi.fn()
const mockReadTextFile = vi.fn()
const mockHomeDir = vi.fn(() => Promise.resolve('/home/user'))

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: (path: string) => mockExists(path),
  readTextFile: (path: string) => mockReadTextFile(path),
}))

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: () => mockHomeDir(),
}))

vi.mock('@/lib/build-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/build-config')>()
  return {
    ...actual,
    // White-label build under test — Knowledge must not look at ~/.amuxd.
    appShortName: 'copilot361',
  }
})

import { amuxdHomePath, resolveTeamDir, TEAM_SHARE_LINK_DIR } from '../team-skill-paths'

describe('team-skill-paths (white-label amuxd home)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHomeDir.mockResolvedValue('/home/user')
    mockExists.mockResolvedValue(false)
    mockReadTextFile.mockResolvedValue('')
  })

  it('amuxdHomePath namespaces white-label under ~/.amuxd-<brand>', () => {
    expect(amuxdHomePath('/home/user', 'copilot361')).toBe('/home/user/.amuxd-copilot361')
    expect(amuxdHomePath('/home/user', 'teamclu')).toBe('/home/user/.amuxd')
  })

  it('resolveTeamDir reads daemon.toml and shared tree from the brand home', async () => {
    const brandHome = '/home/user/.amuxd-copilot361'
    const globalDir = `${brandHome}/teams/team-abc/shared/${TEAM_SHARE_LINK_DIR}`

    mockExists.mockImplementation((path: string) => {
      if (path === `${brandHome}/daemon.toml`) return Promise.resolve(true)
      if (path === globalDir) return Promise.resolve(true)
      if (path.startsWith('/home/user/.amuxd/')) return Promise.resolve(false)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockImplementation((path: string) => {
      if (path === `${brandHome}/daemon.toml`) {
        return Promise.resolve('active_team = "team-abc"\n')
      }
      return Promise.resolve('')
    })

    await expect(resolveTeamDir('/tmp/ws')).resolves.toBe(globalDir)
    expect(mockExists).not.toHaveBeenCalledWith('/home/user/.amuxd/daemon.toml')
  })

  it('resolveTeamDir returns null when only the official ~/.amuxd home is populated', async () => {
    const officialHome = '/home/user/.amuxd'
    const officialDir = `${officialHome}/teams/team-abc/shared/${TEAM_SHARE_LINK_DIR}`

    mockExists.mockImplementation((path: string) => {
      if (path === `${officialHome}/daemon.toml`) return Promise.resolve(true)
      if (path === officialDir) return Promise.resolve(true)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockImplementation((path: string) => {
      if (path === `${officialHome}/daemon.toml`) {
        return Promise.resolve('active_team = "team-abc"\n')
      }
      return Promise.resolve('')
    })

    await expect(resolveTeamDir('/tmp/ws')).resolves.toBeNull()
  })
})

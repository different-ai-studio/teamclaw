import { beforeEach, describe, expect, it, vi } from "vitest"

const mockExists = vi.fn()
const mockMkdir = vi.fn()
const mockReadTextFile = vi.fn()
const mockWriteTextFile = vi.fn()

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: (path: string) => mockExists(path),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  readTextFile: (path: string) => mockReadTextFile(path),
  writeTextFile: (...args: unknown[]) => mockWriteTextFile(...args),
}))

describe("role plugin installer", () => {
  const workspacePath = "/tmp/ws"
  const configPath = "/tmp/ws/opencode.json"
  const roleRootPath = "/tmp/ws/.opencode/roles"
  const roleConfigPath = "/tmp/ws/.opencode/roles/config.json"

  beforeEach(() => {
    vi.clearAllMocks()
    mockExists.mockResolvedValue(false)
    mockMkdir.mockResolvedValue(undefined)
    mockReadTextFile.mockResolvedValue("")
    mockWriteTextFile.mockResolvedValue(undefined)
  })

  it("creates opencode.json with the published role plugin when missing", async () => {
    const { ensureRoleSkillPlugin } = await import("../role-plugin-installer")
    const result = await ensureRoleSkillPlugin(workspacePath)

    expect(result).toEqual({ status: "installed", path: configPath })
    expect(mockMkdir).toHaveBeenCalledWith(roleRootPath, { recursive: true })
    expect(mockWriteTextFile).toHaveBeenCalledTimes(2)
    expect(mockWriteTextFile).toHaveBeenCalledWith(
      roleConfigPath,
      expect.stringContaining('"paths"'),
    )
    expect(mockWriteTextFile).toHaveBeenCalledWith(
      configPath,
      expect.stringContaining('"plugin": [\n    "opencode-roles"\n  ]'),
    )
  })

  it("adds the published role plugin to an existing opencode.json", async () => {
    mockExists.mockImplementation((path: string) => {
      if (path === roleRootPath) return Promise.resolve(true)
      if (path === configPath) return Promise.resolve(true)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockResolvedValue(
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        plugin: ["some-other-plugin"],
      }),
    )

    const { ensureRoleSkillPlugin } = await import("../role-plugin-installer")
    const result = await ensureRoleSkillPlugin(workspacePath)

    expect(result).toEqual({ status: "updated", path: configPath })
    expect(mockWriteTextFile).toHaveBeenCalledWith(
      configPath,
      expect.stringContaining('"opencode-roles"'),
    )
  })

  it("returns conflict when plugin is not a string array", async () => {
    mockExists.mockImplementation((path: string) => {
      if (path === roleRootPath) return Promise.resolve(true)
      if (path === configPath) return Promise.resolve(true)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockResolvedValue(
      JSON.stringify({
        plugin: { name: "opencode-roles" },
      }),
    )

    const { ensureRoleSkillPlugin } = await import("../role-plugin-installer")
    const result = await ensureRoleSkillPlugin(workspacePath)

    expect(result.status).toBe("conflict")
    expect(result.path).toBe(configPath)
    expect(mockWriteTextFile).not.toHaveBeenCalledWith(
      configPath,
      expect.any(String),
    )
  })

  it("does not overwrite an existing role config sample", async () => {
    mockExists.mockImplementation((path: string) => {
      if (path === roleRootPath) return Promise.resolve(true)
      if (path === roleConfigPath) return Promise.resolve(true)
      if (path === configPath) return Promise.resolve(true)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockResolvedValue(
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        plugin: ["opencode-roles"],
      }),
    )

    const { ensureRoleSkillPlugin } = await import("../role-plugin-installer")
    await ensureRoleSkillPlugin(workspacePath)

    expect(mockWriteTextFile).not.toHaveBeenCalledWith(
      roleConfigPath,
      expect.any(String),
    )
  })
})

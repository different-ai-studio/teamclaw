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

vi.mock("../templates/role-skill-plugin.ts.txt?raw", () => ({
  default: "// managed-plugin: role-skill-plugin\n// version: 2\nexport default {}\n",
}))

describe("role plugin installer", () => {
  const workspacePath = "/tmp/ws"
  const targetPath = "/tmp/ws/.opencode/plugins/role-skill.ts"
  const roleRootPath = "/tmp/ws/.opencode/roles"
  const roleConfigPath = "/tmp/ws/.opencode/roles/config.json"

  beforeEach(() => {
    vi.clearAllMocks()
    mockExists.mockResolvedValue(false)
    mockMkdir.mockResolvedValue(undefined)
    mockReadTextFile.mockResolvedValue("")
    mockWriteTextFile.mockResolvedValue(undefined)
  })

  it("installs the managed plugin when the target file is missing", async () => {
    const { ensureRoleSkillPlugin } = await import("../role-plugin-installer")
    const result = await ensureRoleSkillPlugin(workspacePath)

    expect(result).toEqual({ status: "installed", path: targetPath })
    expect(mockMkdir).toHaveBeenCalledWith("/tmp/ws/.opencode/plugins", { recursive: true })
    expect(mockMkdir).toHaveBeenCalledWith(roleRootPath, { recursive: true })
    expect(mockWriteTextFile).toHaveBeenCalledTimes(2)
    expect(mockWriteTextFile).toHaveBeenCalledWith(
      roleConfigPath,
      expect.stringContaining('"paths"'),
    )
    expect(mockWriteTextFile).toHaveBeenCalledWith(
      targetPath,
      expect.stringContaining("managed-plugin: role-skill-plugin"),
    )
  })

  it("updates the managed plugin when the bundled version is newer", async () => {
    mockExists.mockImplementation((path: string) => {
      if (path === "/tmp/ws/.opencode/plugins") return Promise.resolve(true)
      if (path === targetPath) return Promise.resolve(true)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockResolvedValue("// managed-plugin: role-skill-plugin\n// version: 1\n")

    const { ensureRoleSkillPlugin } = await import("../role-plugin-installer")
    const result = await ensureRoleSkillPlugin(workspacePath)

    expect(result).toEqual({ status: "updated", path: targetPath })
    expect(mockWriteTextFile).toHaveBeenCalledWith(
      targetPath,
      expect.stringContaining("managed-plugin: role-skill-plugin"),
    )
  })

  it("returns conflict when an unmanaged plugin already exists", async () => {
    mockExists.mockImplementation((path: string) => {
      if (path === "/tmp/ws/.opencode/plugins") return Promise.resolve(true)
      if (path === targetPath) return Promise.resolve(true)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockResolvedValue("export default {}")

    const { ensureRoleSkillPlugin } = await import("../role-plugin-installer")
    const result = await ensureRoleSkillPlugin(workspacePath)

    expect(result.status).toBe("conflict")
    expect(result.path).toBe(targetPath)
    expect(mockWriteTextFile).toHaveBeenCalledTimes(1)
    expect(mockWriteTextFile).toHaveBeenCalledWith(
      roleConfigPath,
      expect.stringContaining('"paths"'),
    )
  })

  it("does not overwrite an existing role config sample", async () => {
    mockExists.mockImplementation((path: string) => {
      if (path === "/tmp/ws/.opencode/plugins") return Promise.resolve(true)
      if (path === roleRootPath) return Promise.resolve(true)
      if (path === roleConfigPath) return Promise.resolve(true)
      if (path === targetPath) return Promise.resolve(true)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockResolvedValue("// managed-plugin: role-skill-plugin\n// version: 2\n")

    const { ensureRoleSkillPlugin } = await import("../role-plugin-installer")
    await ensureRoleSkillPlugin(workspacePath)

    expect(mockWriteTextFile).not.toHaveBeenCalledWith(
      roleConfigPath,
      expect.any(String),
    )
  })
})

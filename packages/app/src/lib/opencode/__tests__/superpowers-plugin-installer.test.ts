import { beforeEach, describe, expect, it, vi } from "vitest"

const mockExists = vi.fn()
const mockReadTextFile = vi.fn()
const mockWriteTextFile = vi.fn()

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: (path: string) => mockExists(path),
  readTextFile: (path: string) => mockReadTextFile(path),
  writeTextFile: (...args: unknown[]) => mockWriteTextFile(...args),
}))

describe("superpowers plugin installer", () => {
  const workspacePath = "/tmp/ws"
  const configPath = "/tmp/ws/opencode.json"

  beforeEach(() => {
    vi.clearAllMocks()
    mockExists.mockResolvedValue(false)
    mockReadTextFile.mockResolvedValue("")
    mockWriteTextFile.mockResolvedValue(undefined)
  })

  it("creates opencode.json with the superpowers plugin when missing", async () => {
    const { ensureSuperpowersPlugin } = await import("../superpowers-plugin-installer")
    const result = await ensureSuperpowersPlugin(workspacePath)

    expect(result).toEqual({ status: "installed", path: configPath })
    expect(mockWriteTextFile).toHaveBeenCalledTimes(1)
    expect(mockWriteTextFile).toHaveBeenCalledWith(
      configPath,
      expect.stringContaining(
        '"plugin": [\n    "superpowers@git+https://github.com/obra/superpowers.git"\n  ]',
      ),
    )
  })

  it("adds the superpowers plugin to an existing opencode.json", async () => {
    mockExists.mockImplementation((path: string) => {
      if (path === configPath) return Promise.resolve(true)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockResolvedValue(
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        plugin: ["some-other-plugin"],
      }),
    )

    const { ensureSuperpowersPlugin } = await import("../superpowers-plugin-installer")
    const result = await ensureSuperpowersPlugin(workspacePath)

    expect(result).toEqual({ status: "updated", path: configPath })
    expect(mockWriteTextFile).toHaveBeenCalledWith(
      configPath,
      expect.stringContaining('"superpowers@git+https://github.com/obra/superpowers.git"'),
    )
  })

  it("does not duplicate an equivalent alias-based superpowers install", async () => {
    mockExists.mockImplementation((path: string) => {
      if (path === configPath) return Promise.resolve(true)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockResolvedValue(
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        plugin: ["superpowers@github:obra/superpowers"],
      }),
    )

    const { ensureSuperpowersPlugin } = await import("../superpowers-plugin-installer")
    const result = await ensureSuperpowersPlugin(workspacePath)

    expect(result).toEqual({ status: "unchanged", path: configPath })
    expect(mockWriteTextFile).not.toHaveBeenCalled()
  })

  it("does not duplicate a repo-equivalent superpowers install with a different alias", async () => {
    mockExists.mockImplementation((path: string) => {
      if (path === configPath) return Promise.resolve(true)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockResolvedValue(
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        plugin: ["teamclaw-superpowers@git+https://github.com/obra/superpowers.git"],
      }),
    )

    const { ensureSuperpowersPlugin } = await import("../superpowers-plugin-installer")
    const result = await ensureSuperpowersPlugin(workspacePath)

    expect(result).toEqual({ status: "unchanged", path: configPath })
    expect(mockWriteTextFile).not.toHaveBeenCalled()
  })

  it("returns conflict when plugin is not a string array", async () => {
    mockExists.mockImplementation((path: string) => {
      if (path === configPath) return Promise.resolve(true)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockResolvedValue(
      JSON.stringify({
        plugin: { name: "superpowers" },
      }),
    )

    const { ensureSuperpowersPlugin } = await import("../superpowers-plugin-installer")
    const result = await ensureSuperpowersPlugin(workspacePath)

    expect(result.status).toBe("conflict")
    expect(result.path).toBe(configPath)
    expect(mockWriteTextFile).not.toHaveBeenCalled()
  })
})

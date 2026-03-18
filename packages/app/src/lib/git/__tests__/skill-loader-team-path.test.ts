import { describe, it, expect, vi, beforeEach } from "vitest"
import { loadAllSkills, getSourceDirHint } from "../skill-loader"

const mockExists = vi.fn()
const mockReadDir = vi.fn()
const mockReadTextFile = vi.fn()
const mockJoin = vi.fn((...args: string[]) => Promise.resolve(args.join("/")))
const mockHomeDir = vi.fn(() => Promise.resolve("/home/user"))

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: (path: string) => mockExists(path),
  readDir: (path: string) => mockReadDir(path),
  readTextFile: (path: string) => mockReadTextFile(path),
}))

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: () => mockHomeDir(),
  join: (...args: unknown[]) => mockJoin(...(args as string[])),
}))

const opencodejson = (paths: string[]) =>
  JSON.stringify({ skills: { paths } })

describe("skill-loader dynamic team paths (from opencode.json)", () => {
  const workspacePath = "/tmp/ws"

  beforeEach(() => {
    vi.clearAllMocks()
    mockExists.mockReturnValue(false)
    mockReadDir.mockResolvedValue([])
    mockReadTextFile.mockResolvedValue("# Test Skill\n")
    mockHomeDir.mockResolvedValue("/home/user")
    mockJoin.mockImplementation((...args: string[]) => Promise.resolve(args.join("/")))
  })

  it("loads team skills from paths listed in opencode.json", async () => {
    const teamDir = `${workspacePath}/teamclaw-team/skills`

    mockExists.mockImplementation((path: string) => {
      if (path === `${workspacePath}/opencode.json`) return Promise.resolve(true)
      if (path === teamDir) return Promise.resolve(true)
      if (path.includes("my-team-skill") && path.endsWith("SKILL.md")) return Promise.resolve(true)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockImplementation((path: string) => {
      if (path === `${workspacePath}/opencode.json`)
        return Promise.resolve(opencodejson(["teamclaw-team/skills"]))
      if (path.includes("my-team-skill"))
        return Promise.resolve("# my-team-skill\n")
      return Promise.resolve("")
    })
    mockReadDir.mockImplementation((path: string) => {
      if (path === teamDir)
        return Promise.resolve([{ name: "my-team-skill", isDirectory: true }])
      return Promise.resolve([])
    })

    const { skills } = await loadAllSkills(workspacePath)
    const teamSkills = skills.filter((s) => s.source === "team")

    expect(teamSkills.length).toBeGreaterThanOrEqual(1)
    expect(teamSkills.some((s) => s.filename === "my-team-skill")).toBe(true)
  })

  it("resolves ~ paths using homeDir()", async () => {
    const expandedDir = "/home/user/shared-skills"

    mockExists.mockImplementation((path: string) => {
      if (path === `${workspacePath}/opencode.json`) return Promise.resolve(true)
      if (path === expandedDir) return Promise.resolve(true)
      if (path.includes("home-skill") && path.endsWith("SKILL.md")) return Promise.resolve(true)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockImplementation((path: string) => {
      if (path === `${workspacePath}/opencode.json`)
        return Promise.resolve(opencodejson(["~/shared-skills"]))
      if (path.includes("home-skill"))
        return Promise.resolve("# home-skill\n")
      return Promise.resolve("")
    })
    mockReadDir.mockImplementation((path: string) => {
      if (path === expandedDir)
        return Promise.resolve([{ name: "home-skill", isDirectory: true }])
      return Promise.resolve([])
    })

    const { skills } = await loadAllSkills(workspacePath)
    const teamSkills = skills.filter((s) => s.source === "team")

    expect(teamSkills.some((s) => s.filename === "home-skill")).toBe(true)
  })

  it("contributes zero team skills when opencode.json has no skills.paths", async () => {
    mockExists.mockImplementation((path: string) => {
      if (path === `${workspacePath}/opencode.json`) return Promise.resolve(true)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockImplementation((path: string) => {
      if (path === `${workspacePath}/opencode.json`)
        return Promise.resolve(JSON.stringify({}))
      return Promise.resolve("")
    })

    const { skills } = await loadAllSkills(workspacePath)
    expect(skills.filter((s) => s.source === "team")).toHaveLength(0)
  })

  it("getSourceDirHint(team) shows opencode.json config reference", () => {
    expect(getSourceDirHint("team")).toBe("opencode.json → skills.paths")
  })
})

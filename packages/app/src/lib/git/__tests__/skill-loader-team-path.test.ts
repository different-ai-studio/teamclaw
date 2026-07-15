import { describe, it, expect, vi, beforeEach } from "vitest"
import { TEAM_REPO_DIR } from "@/lib/build-config"
import {
  buildSkillInvocationName,
  loadAllSkills,
  getSourceDirHint,
  readConfigSkillPaths,
} from "../skill-loader"
import { collectTeamSkillPaths, TEAM_SHARE_LINK_DIR } from "@/lib/team-skill-paths"

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

const teamclawjson = (paths: string[]) =>
  JSON.stringify({ skills: { paths } })

describe("skill-loader dynamic team paths (from teamclaw.json)", () => {
  const workspacePath = "/tmp/ws"

  beforeEach(() => {
    vi.clearAllMocks()
    mockExists.mockReturnValue(false)
    mockReadDir.mockResolvedValue([])
    mockReadTextFile.mockResolvedValue("# Test Skill\n")
    mockHomeDir.mockResolvedValue("/home/user")
    mockJoin.mockImplementation((...args: string[]) => Promise.resolve(args.join("/")))
  })

  it("loads team skills from paths listed in teamclaw.json", async () => {
    const teamDir = `${workspacePath}/${TEAM_REPO_DIR}/skills`

    mockExists.mockImplementation((path: string) => {
      if (path === `${workspacePath}/teamclaw.json`) return Promise.resolve(true)
      if (path === teamDir) return Promise.resolve(true)
      if (path.includes("my-team-skill") && path.endsWith("SKILL.md")) return Promise.resolve(true)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockImplementation((path: string) => {
      if (path === `${workspacePath}/teamclaw.json`)
        return Promise.resolve(teamclawjson([`${TEAM_REPO_DIR}/skills`]))
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
      if (path === `${workspacePath}/teamclaw.json`) return Promise.resolve(true)
      if (path === expandedDir) return Promise.resolve(true)
      if (path.includes("home-skill") && path.endsWith("SKILL.md")) return Promise.resolve(true)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockImplementation((path: string) => {
      if (path === `${workspacePath}/teamclaw.json`)
        return Promise.resolve(teamclawjson(["~/shared-skills"]))
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

  it("resolves Windows absolute skill paths without prefixing the workspace", async () => {
    const workspacePath = "C:\\Users\\alice\\project"
    const absoluteDir = "D:\\shared\\skills"

    mockExists.mockImplementation((path: string) => {
      if (path === `${workspacePath}/teamclaw.json`) return Promise.resolve(true)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockImplementation((path: string) => {
      if (path === `${workspacePath}/teamclaw.json`) {
        return Promise.resolve(teamclawjson([absoluteDir]))
      }
      return Promise.resolve("")
    })

    await expect(readConfigSkillPaths(workspacePath)).resolves.toEqual([absoluteDir])
  })

  it("resolves Windows home-relative skill paths", async () => {
    const workspacePath = "C:\\Users\\alice\\project"
    mockHomeDir.mockResolvedValue("C:\\Users\\alice")

    mockExists.mockImplementation((path: string) => {
      if (path === `${workspacePath}/teamclaw.json`) return Promise.resolve(true)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockImplementation((path: string) => {
      if (path === `${workspacePath}/teamclaw.json`) {
        return Promise.resolve(teamclawjson(["~\\shared-skills"]))
      }
      return Promise.resolve("")
    })

    await expect(readConfigSkillPaths(workspacePath)).resolves.toEqual([
      "C:\\Users\\alice\\shared-skills",
    ])
  })

  it("contributes zero team skills when no team share dir and no skills.paths", async () => {
    mockExists.mockImplementation((path: string) => {
      if (path === `${workspacePath}/teamclaw.json`) return Promise.resolve(true)
      if (path === `${workspacePath}/opencode.json`) return Promise.resolve(false)
      if (path === `${workspacePath}/${TEAM_SHARE_LINK_DIR}/skills`) return Promise.resolve(false)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockImplementation((path: string) => {
      if (path === `${workspacePath}/teamclaw.json`)
        return Promise.resolve(JSON.stringify({}))
      return Promise.resolve("")
    })

    const { skills } = await loadAllSkills(workspacePath)
    expect(skills.filter((s) => s.source === "team")).toHaveLength(0)
  })

  it("falls back to global team dir when workspace teamclaw-team link is broken", async () => {
    const brokenLinkSkills = `${workspacePath}/${TEAM_SHARE_LINK_DIR}/skills`
    const globalSkills = `/home/user/.amuxd/teams/team-abc/${TEAM_SHARE_LINK_DIR}/skills`

    mockExists.mockImplementation((path: string) => {
      if (path === `${workspacePath}/teamclaw.json`) return Promise.resolve(false)
      if (path === `${workspacePath}/opencode.json`) return Promise.resolve(true)
      if (path === brokenLinkSkills) return Promise.resolve(false)
      if (path === `${workspacePath}/${TEAM_SHARE_LINK_DIR}`) return Promise.resolve(false)
      if (path === `/home/user/.amuxd/daemon.toml`) return Promise.resolve(true)
      if (path === globalSkills) return Promise.resolve(true)
      if (path === `/home/user/.amuxd/teams/team-abc/${TEAM_SHARE_LINK_DIR}`) return Promise.resolve(true)
      if (path.includes("shared-skill") && path.endsWith("SKILL.md")) return Promise.resolve(true)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockImplementation((path: string) => {
      if (path === `${workspacePath}/opencode.json`)
        return Promise.resolve(JSON.stringify({ skills: { paths: ["teamclaw-team/skills"] } }))
      if (path === `/home/user/.amuxd/daemon.toml`)
        return Promise.resolve('team_id = "team-abc"\n')
      if (path.includes("shared-skill")) return Promise.resolve("# shared-skill\n")
      return Promise.resolve("")
    })
    mockReadDir.mockImplementation((path: string) => {
      if (path === globalSkills)
        return Promise.resolve([{ name: "shared-skill", isDirectory: true }])
      return Promise.resolve([])
    })

    const paths = await collectTeamSkillPaths(workspacePath)
    expect(paths).toContain(globalSkills)

    const { skills } = await loadAllSkills(workspacePath)
    expect(skills.some((s) => s.source === "team" && s.filename === "shared-skill")).toBe(true)
  })

  it("auto-loads teamclaw-team/skills without teamclaw.json skills.paths", async () => {
    const teamDir = `${workspacePath}/${TEAM_SHARE_LINK_DIR}/skills`
    expect(TEAM_SHARE_LINK_DIR).toBe("teamclaw-team")

    mockExists.mockImplementation((path: string) => {
      if (path === teamDir) return Promise.resolve(true)
      if (path === `${workspacePath}/${TEAM_SHARE_LINK_DIR}`) return Promise.resolve(true)
      if (path.includes("shared-skill") && path.endsWith("SKILL.md")) return Promise.resolve(true)
      return Promise.resolve(false)
    })
    mockReadDir.mockImplementation((path: string) => {
      if (path === teamDir)
        return Promise.resolve([{ name: "shared-skill", isDirectory: true }])
      return Promise.resolve([])
    })
    mockReadTextFile.mockImplementation((path: string) => {
      if (path.includes("shared-skill")) return Promise.resolve("# shared-skill\n")
      return Promise.resolve("")
    })

    const paths = await collectTeamSkillPaths(workspacePath)
    expect(paths).toContain(teamDir)

    const { skills } = await loadAllSkills(workspacePath)
    expect(skills.some((s) => s.source === "team" && s.filename === "shared-skill")).toBe(true)
  })

  it("loads nested skills from bundle directories", async () => {
    const bundleDir = "/home/user/.agents/skills"
    const superpowersDir = `${bundleDir}/superpowers`

    mockExists.mockImplementation((path: string) => {
      if (path === bundleDir) return Promise.resolve(true)
      if (path === `${superpowersDir}/brainstorming/SKILL.md`) return Promise.resolve(true)
      if (path === `${superpowersDir}/systematic-debugging/SKILL.md`) return Promise.resolve(true)
      return Promise.resolve(false)
    })

    mockReadDir.mockImplementation((path: string) => {
      if (path === bundleDir) {
        return Promise.resolve([{ name: "superpowers", isDirectory: true }])
      }
      if (path === superpowersDir) {
        return Promise.resolve([
          { name: "brainstorming", isDirectory: true },
          { name: "systematic-debugging", isDirectory: true },
        ])
      }
      return Promise.resolve([])
    })

    mockReadTextFile.mockImplementation((path: string) => {
      if (path === `${superpowersDir}/brainstorming/SKILL.md`) {
        return Promise.resolve("---\nname: brainstorming\ndescription: Brainstorm first\n---\n")
      }
      if (path === `${superpowersDir}/systematic-debugging/SKILL.md`) {
        return Promise.resolve("---\nname: systematic-debugging\ndescription: Debug rigorously\n---\n")
      }
      return Promise.resolve("")
    })

    const { skills } = await loadAllSkills(workspacePath)
    const globalAgentSkills = skills.filter((s) => s.source === "global-agent")

    expect(globalAgentSkills.some((s) => s.filename === "brainstorming")).toBe(true)
    expect(globalAgentSkills.some((s) => s.filename === "systematic-debugging")).toBe(true)
    expect(globalAgentSkills.find((s) => s.filename === "brainstorming")?.dirPath).toBe(superpowersDir)
    expect(globalAgentSkills.find((s) => s.filename === "brainstorming")?.invocationName).toBe("superpowers/brainstorming")
  })

  it("prefers flat skill over bundled skill with same slug", async () => {
    const localDir = `${workspacePath}/.teamclaw/skills`
    const globalBundleDir = "/home/user/.agents/skills"
    const superpowersDir = `${globalBundleDir}/superpowers`

    mockExists.mockImplementation((path: string) => {
      if (path === localDir) return Promise.resolve(true)
      if (path === globalBundleDir) return Promise.resolve(true)
      if (path === `${localDir}/brainstorming/SKILL.md`) return Promise.resolve(true)
      if (path === `${superpowersDir}/brainstorming/SKILL.md`) return Promise.resolve(true)
      return Promise.resolve(false)
    })

    mockReadDir.mockImplementation((path: string) => {
      if (path === localDir) {
        return Promise.resolve([{ name: "brainstorming", isDirectory: true }])
      }
      if (path === globalBundleDir) {
        return Promise.resolve([{ name: "superpowers", isDirectory: true }])
      }
      if (path === superpowersDir) {
        return Promise.resolve([{ name: "brainstorming", isDirectory: true }])
      }
      return Promise.resolve([])
    })

    mockReadTextFile.mockImplementation((path: string) => {
      if (path === `${localDir}/brainstorming/SKILL.md`) {
        return Promise.resolve("---\nname: brainstorming\ndescription: Local version\n---\n")
      }
      if (path === `${superpowersDir}/brainstorming/SKILL.md`) {
        return Promise.resolve("---\nname: brainstorming\ndescription: Global bundle version\n---\n")
      }
      return Promise.resolve("")
    })

    const { skills, overrides } = await loadAllSkills(workspacePath)
    const resolved = skills.find((s) => s.filename === "brainstorming")

    expect(resolved?.source).toBe("local")
    expect(resolved?.dirPath).toBe(localDir)
    expect(resolved?.invocationName).toBe("brainstorming")
    expect(overrides).toContainEqual({
      name: "brainstorming",
      winner: "local",
      loser: "global-agent",
    })
  })

  it("builds namespaced invocation names for bundled skills only", () => {
    expect(buildSkillInvocationName("/home/user/.agents/skills", "brainstorming")).toBe("brainstorming")
    expect(buildSkillInvocationName("/home/user/.agents/skills/superpowers", "brainstorming")).toBe("superpowers/brainstorming")
  })

  it("builds invocation names from Windows paths", () => {
    expect(buildSkillInvocationName("C:\\Users\\alice\\.agents\\skills", "brainstorming")).toBe("brainstorming")
    expect(buildSkillInvocationName("C:\\Users\\alice\\.agents\\skills\\superpowers", "brainstorming")).toBe("superpowers/brainstorming")
  })

  it("getSourceDirHint(team) shows team share directory", () => {
    expect(getSourceDirHint("team")).toBe(`${TEAM_REPO_DIR}/skills/ (team share)`)
  })
})

describe("skill-loader plugin cache scanning", () => {
  const workspacePath = "/tmp/ws"
  const pluginCacheDir = `${workspacePath}/.teamclaw/cache/agent/node_modules`

  beforeEach(() => {
    vi.clearAllMocks()
    mockExists.mockReturnValue(false)
    mockReadDir.mockResolvedValue([])
    mockReadTextFile.mockResolvedValue("# Test Skill\n")
    mockHomeDir.mockResolvedValue("/home/user")
  })

  it("loads skills from plugin cache directory", async () => {
    const superpowersSkillsDir = `${pluginCacheDir}/superpowers/skills`

    mockExists.mockImplementation((path: string) => {
      if (path === pluginCacheDir) return Promise.resolve(true)
      if (path === superpowersSkillsDir) return Promise.resolve(true)
      if (path === `${superpowersSkillsDir}/brainstorming/SKILL.md`) return Promise.resolve(true)
      if (path === `${superpowersSkillsDir}/systematic-debugging/SKILL.md`) return Promise.resolve(true)
      return Promise.resolve(false)
    })

    mockReadDir.mockImplementation((path: string) => {
      if (path === pluginCacheDir) {
        return Promise.resolve([{ name: "superpowers", isDirectory: true }])
      }
      if (path === superpowersSkillsDir) {
        return Promise.resolve([
          { name: "brainstorming", isDirectory: true },
          { name: "systematic-debugging", isDirectory: true },
        ])
      }
      return Promise.resolve([])
    })

    mockReadTextFile.mockImplementation((path: string) => {
      if (path === `${superpowersSkillsDir}/brainstorming/SKILL.md`) {
        return Promise.resolve("---\nname: brainstorming\ndescription: Brainstorm first\n---\n")
      }
      if (path === `${superpowersSkillsDir}/systematic-debugging/SKILL.md`) {
        return Promise.resolve("---\nname: systematic-debugging\n---\n")
      }
      return Promise.resolve("")
    })

    const { skills } = await loadAllSkills(workspacePath)
    const pluginSkills = skills.filter((s) => s.source === "plugin")

    expect(pluginSkills).toHaveLength(2)
    expect(pluginSkills.some((s) => s.filename === "brainstorming")).toBe(true)
    expect(pluginSkills.some((s) => s.filename === "systematic-debugging")).toBe(true)
  })

  it("skips plugins without a skills/ directory", async () => {
    mockExists.mockImplementation((path: string) => {
      if (path === pluginCacheDir) return Promise.resolve(true)
      if (path === `${pluginCacheDir}/some-plugin/skills`) return Promise.resolve(false)
      return Promise.resolve(false)
    })

    mockReadDir.mockImplementation((path: string) => {
      if (path === pluginCacheDir) {
        return Promise.resolve([{ name: "some-plugin", isDirectory: true }])
      }
      return Promise.resolve([])
    })

    const { skills } = await loadAllSkills(workspacePath)
    expect(skills.filter((s) => s.source === "plugin")).toHaveLength(0)
  })

  it("local skills override plugin skills with the same name", async () => {
    const localDir = `${workspacePath}/.teamclaw/skills`
    const superpowersSkillsDir = `${pluginCacheDir}/superpowers/skills`

    mockExists.mockImplementation((path: string) => {
      if (path === localDir) return Promise.resolve(true)
      if (path === `${localDir}/brainstorming/SKILL.md`) return Promise.resolve(true)
      if (path === pluginCacheDir) return Promise.resolve(true)
      if (path === superpowersSkillsDir) return Promise.resolve(true)
      if (path === `${superpowersSkillsDir}/brainstorming/SKILL.md`) return Promise.resolve(true)
      return Promise.resolve(false)
    })

    mockReadDir.mockImplementation((path: string) => {
      if (path === localDir) {
        return Promise.resolve([{ name: "brainstorming", isDirectory: true }])
      }
      if (path === pluginCacheDir) {
        return Promise.resolve([{ name: "superpowers", isDirectory: true }])
      }
      if (path === superpowersSkillsDir) {
        return Promise.resolve([{ name: "brainstorming", isDirectory: true }])
      }
      return Promise.resolve([])
    })

    mockReadTextFile.mockImplementation((path: string) => {
      if (path === `${localDir}/brainstorming/SKILL.md`) {
        return Promise.resolve("---\nname: brainstorming\n---\nLocal version")
      }
      if (path === `${superpowersSkillsDir}/brainstorming/SKILL.md`) {
        return Promise.resolve("---\nname: brainstorming\n---\nPlugin version")
      }
      return Promise.resolve("")
    })

    const { skills, overrides } = await loadAllSkills(workspacePath)
    const resolved = skills.find((s) => s.filename === "brainstorming")

    expect(resolved?.source).toBe("local")
    expect(overrides).toContainEqual({
      name: "brainstorming",
      winner: "local",
      loser: "plugin",
    })
  })

  it("skips hidden directories in plugin cache", async () => {
    mockExists.mockImplementation((path: string) => {
      if (path === pluginCacheDir) return Promise.resolve(true)
      return Promise.resolve(false)
    })

    mockReadDir.mockImplementation((path: string) => {
      if (path === pluginCacheDir) {
        return Promise.resolve([
          { name: ".package-lock.json", isDirectory: false },
          { name: ".cache", isDirectory: true },
        ])
      }
      return Promise.resolve([])
    })

    const { skills } = await loadAllSkills(workspacePath)
    expect(skills.filter((s) => s.source === "plugin")).toHaveLength(0)
  })

  it("getSourceDirHint(plugin) shows teamclaw.json reference", () => {
    expect(getSourceDirHint("plugin")).toBe("teamclaw.json → plugin")
  })
})

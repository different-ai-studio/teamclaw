import { beforeEach, describe, expect, it, vi } from "vitest"
import { loadAllRoles, loadRolesSkillsWorkspaceState, parseRoleMarkdown, serializeRoleMarkdown } from "../loader"

const mockExists = vi.fn()
const mockReadDir = vi.fn()
const mockReadTextFile = vi.fn()
const mockMkdir = vi.fn()
const mockWriteTextFile = vi.fn()
const mockLoadAllSkills = vi.fn(async () => ({ skills: [] }))

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: vi.fn(async () => "/Users/tester"),
}))

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: (...args: unknown[]) => mockExists(...args),
  readDir: (...args: unknown[]) => mockReadDir(...args),
  readTextFile: (...args: unknown[]) => mockReadTextFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  writeTextFile: (...args: unknown[]) => mockWriteTextFile(...args),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
}))

vi.mock("@/lib/git/skill-loader", () => ({
  loadAllSkills: (...args: unknown[]) => mockLoadAllSkills(...args),
}))

describe("role markdown helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("parses structured role sections and role skill links", () => {
    const content = `---
name: java-sort-reviewer
description: Review Java sorting implementations
---

## Role
Review sorting code.

## When to use
- QuickSort

## Available role skills
- \`java-complexity-review\`: Explain complexity

## Working style
Be precise.
`

    const parsed = parseRoleMarkdown(content, "java-sort-reviewer")
    expect(parsed.slug).toBe("java-sort-reviewer")
    expect(parsed.description).toBe("Review Java sorting implementations")
    expect(parsed.roleSkills).toEqual([{ name: "java-complexity-review", description: "Explain complexity" }])
  })

  it("serializes role editor state into ROLE.md format", () => {
    const content = serializeRoleMarkdown({
      slug: "algorithm-implementer",
      name: "algorithm-implementer",
      description: "Implement algorithms",
      role: "Implement algorithm tasks.",
      whenToUse: "Use for algorithm questions.",
      workingStyle: "Prefer correctness first.",
      roleSkills: [{ name: "array-basics", description: "Handle array tasks" }],
      rawMarkdown: "",
    })

    expect(content).toContain("name: algorithm-implementer")
    expect(content).toContain("## Available role skills")
    expect(content).toContain("- `array-basics`: Handle array tasks")
  })

  it("loads roles from default root first, then extra config paths", async () => {
    const workspace = "/workspace"
    mockExists.mockImplementation(async (path: string) => {
      return [
        `${workspace}/.opencode/roles`,
        `${workspace}/.opencode/roles/config.json`,
        `${workspace}/.opencode/roles/default-role/ROLE.md`,
        `${workspace}/team-roles`,
        `${workspace}/team-roles/external-role/ROLE.md`,
      ].includes(path)
    })
    mockReadTextFile.mockImplementation(async (path: string) => {
      if (path === `${workspace}/.opencode/roles/config.json`) {
        return JSON.stringify({ paths: ["./team-roles"] })
      }
      if (path.endsWith("default-role/ROLE.md")) {
        return `---
name: default-role
description: Default role
---

## Role
Default

## When to use
Default

## Available role skills

## Working style
Default
`
      }
      return `---
name: external-role
description: External role
---

## Role
External

## When to use
External

## Available role skills

## Working style
External
`
    })
    mockReadDir.mockImplementation(async (path: string) => {
      if (path === `${workspace}/.opencode/roles`) {
        return [{ isDirectory: true, name: "default-role" }, { isDirectory: true, name: "skill" }]
      }
      if (path === `${workspace}/team-roles`) {
        return [{ isDirectory: true, name: "external-role" }]
      }
      return []
    })

    const roles = await loadAllRoles(workspace)
    expect(roles.map((role) => role.slug)).toEqual(["default-role", "external-role"])
    expect(roles[1].filePath).toContain("/team-roles/external-role/ROLE.md")
  })

  it("discovers plural role-skill roots without treating them as roles", async () => {
    const workspace = "/workspace"
    mockExists.mockImplementation(async (path: string) => {
      return [
        `${workspace}/.opencode/roles`,
        `${workspace}/.opencode/roles/config.json`,
        `${workspace}/.opencode/roles/default-role/ROLE.md`,
        `${workspace}/.opencode/roles/skills`,
        `${workspace}/.opencode/roles/skills/design-helper/SKILL.md`,
      ].includes(path)
    })
    mockReadTextFile.mockImplementation(async (path: string) => {
      if (path === `${workspace}/.opencode/roles/config.json`) {
        return JSON.stringify({ paths: [] })
      }
      if (path.endsWith("default-role/ROLE.md")) {
        return `---
name: default-role
description: Default role
---

## Role
Default

## When to use
Default

## Available role skills
- \`design-helper\`: Helps design tasks

## Working style
Default
`
      }
      if (path.endsWith("design-helper/SKILL.md")) {
        return `---
description: Helps design tasks
---

Body
`
      }
      return ""
    })
    mockReadDir.mockImplementation(async (path: string) => {
      if (path === `${workspace}/.opencode/roles`) {
        return [{ isDirectory: true, name: "default-role" }, { isDirectory: true, name: "skills" }]
      }
      if (path === `${workspace}/.opencode/roles/skills`) {
        return [{ isDirectory: true, name: "design-helper" }]
      }
      return []
    })

    const state = await loadRolesSkillsWorkspaceState(workspace)

    expect(state.roles.map((role) => role.slug)).toEqual(["default-role"])
    expect(state.skills).toHaveLength(1)
    expect(state.skills[0].filename).toBe("design-helper")
    expect(state.skills[0].isRoleSkill).toBe(true)
    expect(state.skills[0].linkedRoles).toEqual(["default-role"])
    expect(state.metrics.linkedSkillsCount).toBe(1)
  })

  it("ignores non-role directories under the roles root", async () => {
    const workspace = "/workspace"
    mockExists.mockImplementation(async (path: string) => {
      return [
        `${workspace}/.opencode/roles`,
        `${workspace}/.opencode/roles/config.json`,
        `${workspace}/.opencode/roles/default-role/ROLE.md`,
        `${workspace}/.opencode/roles/legacy`,
        `${workspace}/.opencode/roles/legacy/design-helper/SKILL.md`,
      ].includes(path)
    })
    mockReadTextFile.mockImplementation(async (path: string) => {
      if (path === `${workspace}/.opencode/roles/config.json`) {
        return JSON.stringify({ paths: [] })
      }
      if (path.endsWith("default-role/ROLE.md")) {
        return `---
name: default-role
description: Default role
---

## Role
Default

## When to use
Default

## Available role skills
- \`design-helper\`: Helps design tasks

## Working style
Default
`
      }
      if (path.endsWith("design-helper/SKILL.md")) {
        return `---
description: Helps design tasks
---

Body
`
      }
      return ""
    })
    mockReadDir.mockImplementation(async (path: string) => {
      if (path === `${workspace}/.opencode/roles`) {
        return [{ isDirectory: true, name: "default-role" }, { isDirectory: true, name: "legacy" }]
      }
      if (path === `${workspace}/.opencode/roles/legacy`) {
        return [{ isDirectory: true, name: "design-helper" }]
      }
      return []
    })

    const state = await loadRolesSkillsWorkspaceState(workspace)

    expect(state.roles.map((role) => role.slug)).toEqual(["default-role"])
    expect(state.skills).toHaveLength(0)
    expect(state.skills.some((skill) => skill.isRoleSkill)).toBe(false)
  })
})

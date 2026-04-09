import { homeDir } from "@tauri-apps/api/path"
import { exists, mkdir, readDir, readFile, readTextFile, remove, rename, writeFile, writeTextFile } from "@tauri-apps/plugin-fs"
import type {
  AttachableSkill,
  AttachSkillToRoleInput,
  ManagedSkillRecord,
  RoleEditorState,
  RoleRecord,
  RoleSkillLink,
  RolesSkillsWorkspaceState,
} from "./types"
import { loadAllSkills } from "@/lib/git/skill-loader"

const ROLE_ROOT = ".opencode/roles"
const ROLE_SKILL_DIR = ".opencode/roles/skill"
const ROLE_CONFIG_PATH = ".opencode/roles/config.json"

const SECTION_NAMES = {
  role: "Role",
  whenToUse: "When to use",
  roleSkills: "Available role skills",
  workingStyle: "Working style",
} as const

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n")
}

function parseFrontmatter(content: string): { data: Record<string, string>; body: string } {
  const normalized = normalizeNewlines(content)
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) {
    return { data: {}, body: normalized.trim() }
  }

  const data: Record<string, string> = {}
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":")
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key) data[key] = value
  }

  return { data, body: match[2].trim() }
}

function getSection(body: string, heading: string): string {
  const normalized = normalizeNewlines(body)
  const pattern = new RegExp(`^##\\s+${heading}\\s*$`, "im")
  const match = pattern.exec(normalized)
  if (!match) return ""
  const sectionStart = match.index + match[0].length
  const remaining = normalized.slice(sectionStart).replace(/^\n+/, "")
  const nextHeading = remaining.search(/^##\s+/m)
  return (nextHeading === -1 ? remaining : remaining.slice(0, nextHeading)).trim()
}

function parseRoleSkillLinks(sectionContent: string): RoleSkillLink[] {
  if (!sectionContent.trim()) return []
  return sectionContent
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^-+\s+`([^`]+)`:\s+(.+)$/)
      if (!match) {
        throw new Error(`Invalid role skill entry: ${line}`)
      }
      return {
        name: match[1].trim(),
        description: match[2].trim(),
      }
    })
}

function extractSkillDescription(content: string, fallback: string): string {
  const normalized = normalizeNewlines(content)
  const frontmatterMatch = normalized.match(/^---\n[\s\S]*?\ndescription:\s*(.+?)\n[\s\S]*?---/m)
  if (frontmatterMatch) return frontmatterMatch[1].trim()
  const headingMatch = normalized.match(/^#\s+(.+)$/m)
  return headingMatch?.[1]?.trim() ?? fallback
}

type RoleRoot = {
  rootPath: string
  isDefault: boolean
}

function roleToEditorState(role: RoleRecord): RoleEditorState {
  return {
    slug: role.slug,
    name: role.name,
    description: role.description,
    role: role.role,
    whenToUse: role.whenToUse,
    workingStyle: role.workingStyle,
    roleSkills: role.roleSkills,
    rawMarkdown: role.rawMarkdown,
  }
}

export function createEmptyRoleEditorState(): RoleEditorState {
  const empty = {
    slug: "",
    name: "",
    description: "",
    role: "",
    whenToUse: "",
    workingStyle: "",
    roleSkills: [],
  }
  return {
    ...empty,
    rawMarkdown: serializeRoleMarkdown(empty),
  }
}

export function parseRoleMarkdown(content: string, slug: string, filePath = ""): RoleRecord {
  const normalized = normalizeNewlines(content).trim()
  const { data, body } = parseFrontmatter(normalized)
  const name = data.name?.trim() || slug
  const description = data.description?.trim() || ""
  const role = getSection(body, SECTION_NAMES.role)
  const whenToUse = getSection(body, SECTION_NAMES.whenToUse)
  const workingStyle = getSection(body, SECTION_NAMES.workingStyle)
  const roleSkills = parseRoleSkillLinks(getSection(body, SECTION_NAMES.roleSkills))

  return {
    slug,
    name,
    description,
    body,
    role,
    whenToUse,
    workingStyle,
    roleSkills,
    filePath,
    rawMarkdown: normalized,
  }
}

export function serializeRoleMarkdown(input: Pick<RoleEditorState, "slug" | "name" | "description" | "role" | "whenToUse" | "workingStyle" | "roleSkills">): string {
  const parts = [
    "---",
    `name: ${input.slug.trim()}`,
    `description: ${input.description.trim()}`,
    "---",
    "",
    `## ${SECTION_NAMES.role}`,
    input.role.trim(),
    "",
    `## ${SECTION_NAMES.whenToUse}`,
    input.whenToUse.trim(),
    "",
    `## ${SECTION_NAMES.roleSkills}`,
    ...(input.roleSkills.length > 0
      ? input.roleSkills.map((skill) => `- \`${skill.name}\`: ${skill.description}`)
      : [""]),
    "",
    `## ${SECTION_NAMES.workingStyle}`,
    input.workingStyle.trim(),
    "",
  ]

  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n"
}

export async function ensureRolesRoot(workspacePath: string): Promise<void> {
  const rolesRoot = `${workspacePath}/${ROLE_ROOT}`
  const rolesSkillRoot = `${workspacePath}/${ROLE_SKILL_DIR}`
  if (!(await exists(rolesRoot))) {
    await mkdir(rolesRoot, { recursive: true })
  }
  if (!(await exists(rolesSkillRoot))) {
    await mkdir(rolesSkillRoot, { recursive: true })
  }
  const configPath = `${workspacePath}/${ROLE_CONFIG_PATH}`
  if (!(await exists(configPath))) {
    await writeTextFile(configPath, `${JSON.stringify({ paths: [] }, null, 2)}\n`)
  }
}

async function readRoleConfigPaths(workspacePath: string): Promise<string[]> {
  const configPath = `${workspacePath}/${ROLE_CONFIG_PATH}`
  if (!(await exists(configPath))) return []
  try {
    const content = await readTextFile(configPath)
    const parsed = JSON.parse(content)
    const rawPaths: unknown[] = Array.isArray(parsed?.paths) ? parsed.paths : []
    const home = (await homeDir()).replace(/\/$/, "")
    return rawPaths
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => {
        const trimmed = value.trim()
        if (trimmed === "~" || trimmed.startsWith("~/")) {
          return trimmed.replace(/^~/, home)
        }
        if (trimmed.startsWith("/")) return trimmed
        return `${workspacePath}/${trimmed.replace(/^\.\//, "")}`
      })
  } catch {
    return []
  }
}

async function getRoleRoots(workspacePath: string): Promise<RoleRoot[]> {
  await ensureRolesRoot(workspacePath)
  const roots: RoleRoot[] = [{ rootPath: `${workspacePath}/${ROLE_ROOT}`, isDefault: true }]
  const extraPaths = await readRoleConfigPaths(workspacePath)
  for (const path of extraPaths) {
    if (!roots.some((root) => root.rootPath === path)) {
      roots.push({ rootPath: path, isDefault: false })
    }
  }
  return roots
}

async function loadRoleManagedSkills(workspacePath: string): Promise<ManagedSkillRecord[]> {
  const roots = await getRoleRoots(workspacePath)
  const roleSkills: ManagedSkillRecord[] = []

  for (const root of roots) {
    const roleSkillRoot = `${root.rootPath}/skill`
    if (!(await exists(roleSkillRoot))) continue
    const entries = await readDir(roleSkillRoot)
    for (const entry of entries) {
      if (!entry.isDirectory || !entry.name) continue
      const skillPath = `${roleSkillRoot}/${entry.name}/SKILL.md`
      if (!(await exists(skillPath))) continue
      const content = await readTextFile(skillPath)
      roleSkills.push({
        filename: entry.name,
        name: entry.name,
        content,
        description: extractSkillDescription(content, entry.name),
        source: "local",
        dirPath: roleSkillRoot,
        linkedRoles: [],
        isRoleSkill: true,
      })
    }
  }

  return roleSkills
}

export async function loadAllRoles(workspacePath: string | null): Promise<RoleRecord[]> {
  if (!workspacePath) return []
  const roles: RoleRecord[] = []
  const seen = new Set<string>()
  const roots = await getRoleRoots(workspacePath)

  for (const root of roots) {
    if (!(await exists(root.rootPath))) continue
    const entries = await readDir(root.rootPath)
    for (const entry of entries) {
      if (!entry.isDirectory || !entry.name || entry.name === "skill") continue
      const rolePath = `${root.rootPath}/${entry.name}/ROLE.md`
      if (!(await exists(rolePath))) continue
      if (seen.has(entry.name)) continue
      const content = await readTextFile(rolePath)
      roles.push(parseRoleMarkdown(content, entry.name, rolePath))
      seen.add(entry.name)
    }
  }

  return roles.sort((a, b) => a.slug.localeCompare(b.slug))
}

export async function loadRolesSkillsWorkspaceState(workspacePath: string | null): Promise<RolesSkillsWorkspaceState> {
  if (!workspacePath) {
    return {
      roles: [],
      skills: [],
      roleUsageBySkill: {},
      skillNamesByRole: {},
      metrics: {
        rolesCount: 0,
        skillsCount: 0,
        linkedSkillsCount: 0,
        unlinkedSkillsCount: 0,
      },
    }
  }

  const [roles, { skills: normalSkills }, roleManagedSkills] = await Promise.all([
    loadAllRoles(workspacePath),
    loadAllSkills(workspacePath),
    loadRoleManagedSkills(workspacePath),
  ])

  const roleUsageBySkill: Record<string, string[]> = {}
  const skillNamesByRole: Record<string, string[]> = {}

  for (const role of roles) {
    skillNamesByRole[role.slug] = role.roleSkills.map((skill) => skill.name)
    for (const roleSkill of role.roleSkills) {
      const owners = roleUsageBySkill[roleSkill.name] ?? []
      owners.push(role.slug)
      roleUsageBySkill[roleSkill.name] = owners
    }
  }

  const managedSkillsByKey = new Map<string, ManagedSkillRecord>()

  for (const skill of normalSkills) {
    const key = `${skill.dirPath ?? ""}:${skill.filename}`
    managedSkillsByKey.set(key, {
      filename: skill.filename,
      name: skill.name,
      content: skill.content,
      description: extractSkillDescription(skill.content, skill.name),
      source: skill.source,
      dirPath: skill.dirPath ?? `${workspacePath}/.opencode/skills`,
      linkedRoles: roleUsageBySkill[skill.filename] ?? [],
      isRoleSkill: false,
    })
  }

  for (const skill of roleManagedSkills) {
    const key = `${skill.dirPath}:${skill.filename}`
    managedSkillsByKey.set(key, {
      ...skill,
      linkedRoles: roleUsageBySkill[skill.filename] ?? [],
    })
  }

  const skills = Array.from(managedSkillsByKey.values()).sort((a, b) => {
    if (a.isRoleSkill !== b.isRoleSkill) return a.isRoleSkill ? 1 : -1
    return a.filename.localeCompare(b.filename)
  })

  const linkedSkillsCount = Object.values(roleUsageBySkill).filter((owners) => owners.length > 0).length

  return {
    roles,
    skills,
    roleUsageBySkill,
    skillNamesByRole,
    metrics: {
      rolesCount: roles.length,
      skillsCount: skills.length,
      linkedSkillsCount,
      unlinkedSkillsCount: Math.max(skills.length - linkedSkillsCount, 0),
    },
  }
}

export async function saveRole(workspacePath: string, editor: RoleEditorState, targetFilePath?: string): Promise<RoleRecord> {
  await ensureRolesRoot(workspacePath)
  const slug = editor.slug.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")
  if (!slug) {
    throw new Error("Role name is required")
  }

  const rolePath = targetFilePath ?? `${workspacePath}/${ROLE_ROOT}/${slug}/ROLE.md`
  const roleDir = rolePath.slice(0, rolePath.lastIndexOf("/"))
  if (!(await exists(roleDir))) {
    await mkdir(roleDir, { recursive: true })
  }

  const markdown = serializeRoleMarkdown({ ...editor, slug })
  await writeTextFile(rolePath, markdown)
  return parseRoleMarkdown(markdown, slug, rolePath)
}

export async function deleteRole(workspacePath: string, roleSlug: string, roleFilePath?: string): Promise<void> {
  if (roleFilePath) {
    const roleDirFromPath = roleFilePath.slice(0, roleFilePath.lastIndexOf("/"))
    if (await exists(roleDirFromPath)) {
      await remove(roleDirFromPath, { recursive: true })
      return
    }
  }

  const roots = await getRoleRoots(workspacePath)
  let roleDir = `${workspacePath}/${ROLE_ROOT}/${roleSlug}`
  for (const root of roots) {
    const candidate = `${root.rootPath}/${roleSlug}`
    if (await exists(candidate)) {
      roleDir = candidate
      break
    }
  }
  if (await exists(roleDir)) {
    await remove(roleDir, { recursive: true })
  }
}

export async function loadAttachableSkills(workspacePath: string): Promise<AttachableSkill[]> {
  const { skills } = await loadAllSkills(workspacePath)
  const workspaceSkillRoot = `${workspacePath}/.opencode/skills`
  return skills
    .filter((skill) => skill.source === "local" && skill.dirPath === workspaceSkillRoot)
    .map((skill) => ({
      filename: skill.filename,
      name: skill.name,
      description: extractSkillDescription(skill.content, skill.name),
      content: skill.content,
      dirPath: skill.dirPath,
      source: skill.source,
    }))
    .sort((a, b) => a.filename.localeCompare(b.filename))
}

async function copyItem(sourcePath: string, targetDir: string): Promise<void> {
  const name = sourcePath.split("/").pop()
  if (!name) throw new Error(`Invalid source path: ${sourcePath}`)
  const destinationPath = `${targetDir}/${name}`

  try {
    const entries = await readDir(sourcePath)
    if (!(await exists(destinationPath))) {
      await mkdir(destinationPath, { recursive: true })
    }
    for (const entry of entries) {
      if (!entry.name) continue
      await copyItem(`${sourcePath}/${entry.name}`, destinationPath)
    }
    return
  } catch {
    const bytes = await readFile(sourcePath)
    await writeFile(destinationPath, bytes)
  }
}

function upsertRoleSkillLink(links: RoleSkillLink[], next: RoleSkillLink): RoleSkillLink[] {
  const existing = links.find((link) => link.name === next.name)
  if (!existing) return [...links, next]
  return links.map((link) => (link.name === next.name ? next : link))
}

export async function attachSkillToRole(input: AttachSkillToRoleInput): Promise<RoleRecord> {
  const { workspacePath, roleSlug, skillSlug, mode } = input
  await ensureRolesRoot(workspacePath)

  const rolePath = `${workspacePath}/${ROLE_ROOT}/${roleSlug}/ROLE.md`
  if (!(await exists(rolePath))) {
    throw new Error(`Role "${roleSlug}" does not exist`)
  }

  const sourceDir = `${workspacePath}/.opencode/skills/${skillSlug}`
  const sourceSkillPath = `${sourceDir}/SKILL.md`
  if (!(await exists(sourceSkillPath))) {
    throw new Error(`Skill "${skillSlug}" is not available for role attachment`)
  }

  const roleSkillDir = `${workspacePath}/${ROLE_SKILL_DIR}/${skillSlug}`
  const roleSkillPath = `${roleSkillDir}/SKILL.md`
  if (await exists(roleSkillDir)) {
    const existingRole = parseRoleMarkdown(await readTextFile(rolePath), roleSlug, rolePath)
    if (existingRole.roleSkills.some((skill) => skill.name === skillSlug)) {
      return existingRole
    }
    throw new Error(`Role skill "${skillSlug}" already exists`)
  }

  const roleSkillRoot = `${workspacePath}/${ROLE_SKILL_DIR}`
  if (!(await exists(roleSkillRoot))) {
    await mkdir(roleSkillRoot, { recursive: true })
  }

  if (mode === "copy") {
    await mkdir(roleSkillDir, { recursive: true })
    await copyItem(sourceDir, roleSkillRoot)
  } else {
    await rename(sourceDir, roleSkillDir)
  }

  const role = parseRoleMarkdown(await readTextFile(rolePath), roleSlug, rolePath)
  const skillContent = await readTextFile(roleSkillPath)
  const nextRole = {
    ...role,
    roleSkills: upsertRoleSkillLink(role.roleSkills, {
      name: skillSlug,
      description: extractSkillDescription(skillContent, skillSlug),
    }),
  }

  await writeTextFile(rolePath, serializeRoleMarkdown(nextRole))
  return parseRoleMarkdown(await readTextFile(rolePath), roleSlug, rolePath)
}

export { roleToEditorState, extractSkillDescription }

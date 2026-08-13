/**
 * Team-share detail views, addressed as tab targets.
 *
 * The third column used to be a second, parallel main area: App.tsx rendered
 * either the tab strip or the team-share detail pane, each with its own idea of
 * what was selected. Anything that wanted to open something had to know which
 * of the two it was standing in — and when it guessed wrong the panel simply
 * never appeared (version history did exactly this).
 *
 * So a team-share view is now a tab like any other. The target string is the
 * whole address: it survives a reload, it deduplicates (the tabs store keys on
 * `type` + `target`), and it is what the list column reads back to decide which
 * row is highlighted. Keep it parseable from the string alone — no side table.
 */

export type TeamShareTabTarget =
  | { kind: 'skill'; id: string }
  /** One file inside a skill package. `rel` is package-relative, `/`-separated. */
  | { kind: 'skill-file'; id: string; rel: string }
  | { kind: 'mcp'; name: string }
  | { kind: 'env'; keyId: string }
  /** The compose surface for a new MCP server or env key. */
  | { kind: 'create'; section: 'mcp' | 'env' }

const PREFIX = 'teamshare:'

/** Version history is not team-share-specific, so it keeps its own prefix. */
const VERSION_HISTORY = 'version-history'

export function encodeTeamShareTarget(t: TeamShareTabTarget): string {
  switch (t.kind) {
    case 'skill':
      return `${PREFIX}skill/${t.id}`
    case 'skill-file':
      return `${PREFIX}skill-file/${t.id}/${t.rel}`
    case 'mcp':
      return `${PREFIX}mcp/${t.name}`
    case 'env':
      return `${PREFIX}env/${t.keyId}`
    case 'create':
      return `${PREFIX}create/${t.section}`
  }
}

/**
 * Parse a tab target back into a view, or null when it is not one of ours.
 *
 * Only the *first* separator after the kind is significant: ids never contain
 * `/` (a slug, or `personal:<slug>`), while the rest — a package-relative file
 * path — routinely does.
 */
export function decodeTeamShareTarget(target: string): TeamShareTabTarget | null {
  if (!target.startsWith(PREFIX)) return null
  const body = target.slice(PREFIX.length)
  const slash = body.indexOf('/')
  if (slash <= 0) return null
  const kind = body.slice(0, slash)
  const rest = body.slice(slash + 1)
  if (!rest) return null

  switch (kind) {
    case 'skill':
      return { kind: 'skill', id: rest }
    case 'skill-file': {
      const cut = rest.indexOf('/')
      if (cut <= 0) return null
      const rel = rest.slice(cut + 1)
      if (!rel) return null
      return { kind: 'skill-file', id: rest.slice(0, cut), rel }
    }
    case 'mcp':
      return { kind: 'mcp', name: rest }
    case 'env':
      return { kind: 'env', keyId: rest }
    case 'create':
      return rest === 'mcp' || rest === 'env' ? { kind: 'create', section: rest } : null
    default:
      return null
  }
}

export function encodeVersionHistoryTarget(path: string): string {
  return `${VERSION_HISTORY}/${path}`
}

/**
 * The file whose history a target names, `null` for the browse-everything view
 * (the bare `version-history` target) and `undefined` when it is not a version
 * history target at all.
 */
export function decodeVersionHistoryTarget(target: string): string | null | undefined {
  if (target === VERSION_HISTORY) return null
  if (!target.startsWith(`${VERSION_HISTORY}/`)) return undefined
  return target.slice(VERSION_HISTORY.length + 1) || null
}

/** Every target this module owns, for bulk close when the team changes. */
export function isTeamShareOwnedTarget(target: string): boolean {
  return target.startsWith(PREFIX) || decodeVersionHistoryTarget(target) !== undefined
}

/**
 * Which team-share row a tab highlights, if any.
 *
 * A file inside a package still belongs to its skill: the list column keeps the
 * skill row marked while one of its files is open, which is what makes the
 * folder read as "this is where you are".
 */
export function tabSelectionForSection(
  target: string,
  section: 'skills' | 'mcp' | 'env' | 'knowledge',
): string | null {
  const t = decodeTeamShareTarget(target)
  if (!t) return null
  if (section === 'skills') {
    if (t.kind === 'skill') return t.id
    if (t.kind === 'skill-file') return t.id
    return null
  }
  if (section === 'mcp') return t.kind === 'mcp' ? t.name : null
  if (section === 'env') return t.kind === 'env' ? t.keyId : null
  return null
}

import { readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs'
import { join } from '@tauri-apps/api/path'

/**
 * Default entries that should be in workspace .gitignore
 */
export const TEAMCLAW_GITIGNORE_ENTRIES = [
  '# TeamClaw system directories',
  '.teamclaw/',
  '.opencode/',
]

/**
 * Parse gitignore content into array of lines
 */
export function parseGitignore(content: string): string[] {
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

/**
 * Check if an entry already exists in gitignore (handles exact match and variations)
 */
function hasEntry(lines: string[], entry: string): boolean {
  const normalizedEntry = entry.replace(/\/$/, '') // Remove trailing slash for comparison
  return lines.some(line => {
    const normalizedLine = line.replace(/\/$/, '')
    return normalizedLine === normalizedEntry || normalizedLine === entry
  })
}

/**
 * Ensure .gitignore contains required TeamClaw entries
 * Creates .gitignore if it doesn't exist, or appends missing entries
 */
export async function ensureGitignoreEntries(workspacePath: string): Promise<void> {
  try {
    const gitignorePath = await join(workspacePath, '.gitignore')

    const gitignoreExists = await exists(gitignorePath)

    if (!gitignoreExists) {
      // Create new .gitignore with entries
      const content = TEAMCLAW_GITIGNORE_ENTRIES.join('\n') + '\n'
      await writeTextFile(gitignorePath, content)
      console.log('[Gitignore] Created .gitignore with TeamClaw entries')
      return
    }

    // Read existing .gitignore
    const existingContent = await readTextFile(gitignorePath)
    const lines = parseGitignore(existingContent)

    // Find missing entries
    const missingEntries = TEAMCLAW_GITIGNORE_ENTRIES.filter(entry =>
      !entry.startsWith('#') && !hasEntry(lines, entry)
    )

    if (missingEntries.length === 0) {
      console.log('[Gitignore] All entries already present')
      return
    }

    // Append missing entries with comment header
    let newContent = existingContent
    if (!existingContent.endsWith('\n')) {
      newContent += '\n'
    }
    newContent += '\n# TeamClaw system directories\n'
    newContent += missingEntries.join('\n') + '\n'

    await writeTextFile(gitignorePath, newContent)
    console.log('[Gitignore] Added missing entries:', missingEntries)
  } catch (error) {
    console.error('[Gitignore] Failed to ensure gitignore entries:', error)
  }
}

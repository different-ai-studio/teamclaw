// Contact type definition
export interface Contact {
  id: string
  name: string
  email?: string
  group?: string
}

/**
 * Parse contacts from markdown content
 * Supports two formats:
 * 1. List format: `- 姓名 (email)` or `- 姓名`
 * 2. Table format: `| 姓名 | 邮箱 | 分组 |`
 */
export function parseContactsMarkdown(content: string): Contact[] {
  const contacts: Contact[] = []
  const lines = content.split('\n')
  
  let currentGroup: string | undefined
  
  for (const line of lines) {
    const trimmed = line.trim()
    
    // Skip empty lines and headers
    if (!trimmed || trimmed.startsWith('#')) {
      // Extract group name from headers
      const headerMatch = trimmed.match(/^#+\s*(.+)$/)
      if (headerMatch) {
        currentGroup = headerMatch[1].trim()
      }
      continue
    }
    
    // Skip YAML frontmatter
    if (trimmed === '---') {
      continue
    }
    
    // Parse list format: `- 姓名 (email)` or `- 姓名`
    const listMatch = trimmed.match(/^[-*]\s+(.+?)(?:\s*\(([^)]+)\))?\s*$/)
    if (listMatch) {
      const name = listMatch[1].trim()
      const email = listMatch[2]?.trim()
      const id = email || name.toLowerCase().replace(/\s+/g, '-')
      
      contacts.push({
        id,
        name,
        email,
        group: currentGroup,
      })
      continue
    }
    
    // Parse table format: `| 姓名 | 邮箱 | 分组 |`
    // Skip table header separator line
    if (trimmed.match(/^\|[\s-|:]+\|$/)) {
      continue
    }
    
    const tableMatch = trimmed.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/)
    if (tableMatch) {
      const name = tableMatch[1].trim()
      const email = tableMatch[2].trim() || undefined
      const group = tableMatch[3].trim() || currentGroup
      const id = email || name.toLowerCase().replace(/\s+/g, '-')
      
      // Skip header row
      if (name.toLowerCase() === '姓名' || name.toLowerCase() === 'name') {
        continue
      }
      
      contacts.push({
        id,
        name,
        email,
        group,
      })
    }
  }
  
  return contacts
}

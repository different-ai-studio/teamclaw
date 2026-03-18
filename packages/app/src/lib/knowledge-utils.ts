/**
 * Pure utility functions for the knowledge module.
 * Extracted from components for testability.
 */

import type { TFunction } from 'i18next'

/**
 * Format an ISO date string as a relative time (e.g. "5 minutes ago").
 */
export function formatTimeAgo(isoString: string | undefined, t: TFunction): string {
  if (!isoString) return t('common.never')

  const date = new Date(isoString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)

  if (diffMins < 1) return t('common.justNow')
  if (diffMins < 60) return t('common.minutesAgo', { count: diffMins })

  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return t('common.hoursAgo', { count: diffHours })

  const diffDays = Math.floor(diffHours / 24)
  return t('common.daysAgo', { count: diffDays })
}

/**
 * Return a badge variant based on search relevance score.
 */
export function getScoreBadgeVariant(score: number): 'default' | 'secondary' | 'outline' {
  if (score >= 0.8) return 'default'
  if (score >= 0.5) return 'secondary'
  return 'outline'
}

export interface KnowledgeItem {
  path: string
  name: string
  type: 'file' | 'directory'
  size?: number
  modifiedAt?: Date
  children?: KnowledgeItem[]
}

/**
 * Recursively filter knowledge items by a search query (case-insensitive).
 * Preserves parent directory structure when a child matches.
 */
export function filterKnowledgeItems(items: KnowledgeItem[], searchQuery: string): KnowledgeItem[] {
  if (!searchQuery.trim()) return items

  const query = searchQuery.toLowerCase()
  return items
    .filter((item) => {
      if (item.name.toLowerCase().includes(query)) return true
      if (item.type === 'directory' && item.children) {
        return filterKnowledgeItems(item.children, searchQuery).length > 0
      }
      return false
    })
    .map((item) => {
      if (item.type === 'directory' && item.children) {
        return { ...item, children: filterKnowledgeItems(item.children, searchQuery) }
      }
      return item
    })
}

/** File extensions that are sent through markitdown conversion */
export const CONVERTIBLE_EXTENSIONS = [
  'pdf', 'docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls',
  'csv', 'html', 'htm', 'xml', 'rss', 'atom', 'zip',
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'webp',
  'mp3', 'wav', 'ogg', 'flac',
]

/** File extensions that are copied directly without conversion */
export const DIRECT_COPY_EXTENSIONS = ['md', 'txt']

/**
 * Classify a file path as 'convert', 'copy', or 'unsupported'.
 */
export function classifyFileType(filePath: string): 'convert' | 'copy' | 'unsupported' {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  if (CONVERTIBLE_EXTENSIONS.includes(ext)) return 'convert'
  if (DIRECT_COPY_EXTENSIONS.includes(ext)) return 'copy'
  return 'unsupported'
}

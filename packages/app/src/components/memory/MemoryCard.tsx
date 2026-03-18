import type { MemoryRecord } from '@/stores/memory'
import { useMemoryStore } from '@/stores/memory'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Trash2, ChevronDown, ChevronUp } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import { useState } from 'react'

interface MemoryCardProps {
  memory: MemoryRecord
}

const CATEGORY_COLORS: Record<string, string> = {
  preference: 'bg-blue-500/10 text-blue-700 dark:text-blue-300',
  correction: 'bg-red-500/10 text-red-700 dark:text-red-300',
  fact: 'bg-green-500/10 text-green-700 dark:text-green-300',
  workflow: 'bg-purple-500/10 text-purple-700 dark:text-purple-300',
}

const CATEGORY_LABELS: Record<string, string> = {
  preference: '偏好',
  correction: '纠错',
  fact: '事实',
  workflow: '流程',
}

export function MemoryCard({ memory }: MemoryCardProps) {
  const [expanded, setExpanded] = useState(false)
  const { deleteMemory } = useMemoryStore()

  const handleDelete = async () => {
    if (confirm('确认删除这条记忆？')) {
      await deleteMemory(memory.filename)
    }
  }

  const categoryColor = CATEGORY_COLORS[memory.category] || 'bg-gray-500/10 text-gray-700 dark:text-gray-300'
  const categoryLabel = CATEGORY_LABELS[memory.category] || memory.category

  const displayTime = memory.updated || memory.created
  let timeAgo = ''
  if (displayTime) {
    try {
      timeAgo = formatDistanceToNow(new Date(displayTime), {
        addSuffix: true,
        locale: zhCN,
      })
    } catch {
      timeAgo = displayTime
    }
  }

  const contentPreview = memory.content.length > 120
    ? memory.content.slice(0, 120) + '...'
    : memory.content

  return (
    <Card className="p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            {memory.category && (
              <Badge variant="secondary" className={categoryColor}>
                {categoryLabel}
              </Badge>
            )}
            <span className="text-sm font-medium truncate">{memory.title}</span>
          </div>

          <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
            {expanded ? memory.content : contentPreview}
          </p>

          {memory.content.length > 120 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1 mt-1 text-xs text-muted-foreground"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? (
                <><ChevronUp className="h-3 w-3 mr-0.5" />收起</>
              ) : (
                <><ChevronDown className="h-3 w-3 mr-0.5" />展开</>
              )}
            </Button>
          )}

          {memory.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {memory.tags.map(tag => (
                <Badge key={tag} variant="outline" className="text-xs">
                  {tag}
                </Badge>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2 mt-2">
            {timeAgo && (
              <span className="text-xs text-muted-foreground">{timeAgo}</span>
            )}
            <span className="text-xs text-muted-foreground/50">{memory.filename}</span>
          </div>
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={handleDelete}
          className="h-7 w-7 p-0 text-destructive hover:text-destructive shrink-0"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </Card>
  )
}

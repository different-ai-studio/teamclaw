import { useEffect } from 'react'
import { useMemoryStore } from '@/stores/memory'
import { MemoryCard } from './MemoryCard'
import { MemorySearch } from './MemorySearch'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Loader2, Brain, Sparkles, RefreshCw } from 'lucide-react'

export function MemoryPanel() {
  const {
    memories,
    isLoading,
    isExtracting,
    error,
    searchQuery,
    selectedCategory,
    loadMemories,
    triggerExtraction,
  } = useMemoryStore()

  useEffect(() => {
    loadMemories()
  }, [loadMemories])

  const filteredMemories = selectedCategory
    ? memories.filter((m) => m.category === selectedCategory)
    : memories

  return (
    <div className="flex h-full flex-col">
      <div className="border-b p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Brain className="h-5 w-5" />
            <h2 className="text-lg font-semibold">长期记忆</h2>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => loadMemories()}
              disabled={isLoading}
              title="刷新"
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={triggerExtraction}
              disabled={isExtracting}
              title="从当前会话提取记忆"
            >
              {isExtracting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          已存储 {memories.length} 条记忆
        </p>
      </div>

      <div className="border-b p-4">
        <MemorySearch />
      </div>

      {error && (
        <div className="border-b bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-3">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : filteredMemories.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Brain className="h-12 w-12 text-muted-foreground/50 mb-2" />
              <p className="text-sm text-muted-foreground">
                {searchQuery
                  ? '没有找到匹配的记忆'
                  : '暂无记忆'}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                对话中的关键信息会自动被记忆，也可以点击上方的提取按钮手动触发
              </p>
            </div>
          ) : (
            filteredMemories.map((memory) => (
              <MemoryCard key={memory.filename} memory={memory} />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

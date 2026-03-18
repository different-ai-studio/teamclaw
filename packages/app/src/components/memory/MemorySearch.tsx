import { useState } from 'react'
import { useMemoryStore } from '@/stores/memory'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Search, X } from 'lucide-react'

const CATEGORIES = [
  { value: 'preference', label: '偏好' },
  { value: 'correction', label: '纠错' },
  { value: 'fact', label: '事实' },
  { value: 'workflow', label: '流程' },
]

export function MemorySearch() {
  const {
    searchQuery,
    selectedCategory,
    setSearchQuery,
    setSelectedCategory,
    searchMemories,
    loadMemories,
  } = useMemoryStore()

  const [localQuery, setLocalQuery] = useState(searchQuery)

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    if (localQuery.trim()) {
      searchMemories(localQuery)
    } else {
      loadMemories()
    }
  }

  const handleClear = () => {
    setLocalQuery('')
    setSearchQuery('')
    setSelectedCategory(null)
    loadMemories()
  }

  return (
    <form onSubmit={handleSearch} className="space-y-2">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="text"
            placeholder="搜索记忆..."
            value={localQuery}
            onChange={(e) => setLocalQuery(e.target.value)}
            className="pl-8"
          />
        </div>
        <Button type="submit" size="sm">
          搜索
        </Button>
        {(searchQuery || selectedCategory) && (
          <Button type="button" variant="ghost" size="sm" onClick={handleClear}>
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      <Select
        value={selectedCategory || 'all'}
        onValueChange={(value) =>
          setSelectedCategory(value === 'all' ? null : value)
        }
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder="所有分类" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">所有分类</SelectItem>
          {CATEGORIES.map((cat) => (
            <SelectItem key={cat.value} value={cat.value}>
              {cat.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </form>
  )
}

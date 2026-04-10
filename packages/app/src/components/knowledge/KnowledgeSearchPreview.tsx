import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Search, Loader2, FileText, ChevronRight } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { isTauri } from '@/lib/utils'
import { getScoreBadgeVariant } from '@/lib/knowledge-utils'
import { useWorkspaceStore } from '@/stores/workspace'
import { useUIStore } from '@/stores/ui'
import { useKnowledgeStore, type SearchResult } from '@/stores/knowledge'
import { createWikiLinkRegex, parseWikiLinkText } from '@/lib/wiki-link-utils'

function ContentWithWikiLinks({ text, onLinkClick }: {
  text: string
  onLinkClick: (target: string, heading?: string) => void
}) {
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  const regex = createWikiLinkRegex()
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    // Skip wiki links inside inline code (odd number of backticks before match)
    const before = text.slice(0, match.index)
    if ((before.match(/`/g) ?? []).length % 2 === 1) continue

    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }

    const parsed = parseWikiLinkText(match[1])
    parts.push(
      <button
        key={match.index}
        className="wiki-link text-sm"
        onClick={(e) => {
          e.stopPropagation()
          onLinkClick(parsed.target, parsed.heading ?? undefined)
        }}
      >
        {parsed.alias || parsed.target}
      </button>
    )

    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return <>{parts}</>
}

export const KnowledgeSearchPreview = React.memo(function KnowledgeSearchPreview() {
  const { t } = useTranslation()
  const selectFile = useWorkspaceStore((s) => s.selectFile)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const closeSettings = useUIStore((s) => s.closeSettings)
  
  const {
    searchResults: results,
    isSearching,
    searchQuery: query,
    searchMode,
    searchTime,
    searchReranked,
    searchRerankError,
    search,
    setSearchMode,
    setSearchQuery,
  } = useKnowledgeStore()

  const handleSearch = React.useCallback(async () => {
    if (!query.trim() || !isTauri()) return
    await search(query)
  }, [query, search])

  const handleResultClick = React.useCallback((result: SearchResult) => {
    if (!workspacePath) return
    // Convert relative path to absolute path
    // result.source is relative to knowledge/ directory (e.g., "examples/file.md")
    // so we need to prepend "knowledge/" and workspace path
    const absolutePath = `${workspacePath}/knowledge/${result.source}`
    
    // Pass the start line for code files, or heading for Markdown files
    selectFile(absolutePath, result.startLine, result.heading)
    closeSettings()
  }, [selectFile, closeSettings, workspacePath])

  return (
    <div className="space-y-4 w-full overflow-hidden">
      <div className="flex gap-2">
        <Input
          placeholder={t('knowledge.search.placeholder', 'Search knowledge base...')}
          value={query}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              handleSearch()
            }
          }}
          className="flex-1 min-w-0"
        />
        <Select value={searchMode} onValueChange={setSearchMode}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="hybrid">{t('knowledge.search.mode.hybrid', 'Hybrid')}</SelectItem>
            <SelectItem value="semantic">{t('knowledge.search.mode.semantic', 'Semantic')}</SelectItem>
            <SelectItem value="bm25">{t('knowledge.search.mode.bm25', 'Keyword')}</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={handleSearch} disabled={isSearching || !query.trim()}>
          {isSearching ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Search className="h-4 w-4" />
          )}
        </Button>
      </div>

      {searchTime > 0 && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>{t('knowledge.search.found', 'Found {{count}} results ({{time}}ms)', { count: results.length, time: searchTime })}</span>
            <div className="flex items-center gap-1.5">
              {searchReranked && (
                <Badge variant="default" className="text-xs">Reranked</Badge>
              )}
              <Badge variant="outline" className="text-xs">
                {searchMode === 'hybrid' && t('knowledge.search.mode.hybrid', 'Hybrid')}
                {searchMode === 'semantic' && t('knowledge.search.mode.semantic', 'Semantic')}
                {searchMode === 'bm25' && t('knowledge.search.mode.bm25', 'Keyword')}
              </Badge>
            </div>
          </div>
          {searchRerankError && (
            <p className="text-xs text-destructive">{t('knowledge.search.rerankFailed', 'Rerank failed: {{error}}', { error: searchRerankError })}</p>
          )}
        </div>
      )}

      <ScrollArea className="h-[400px]">
        <div className="space-y-2 pr-4">
          {results.map((result, index) => (
            <Card
              key={index}
              className="cursor-pointer hover:bg-accent transition-colors py-3"
              onClick={() => handleResultClick(result)}
            >
              <CardContent className="px-4">
                <div className="flex items-center gap-2 mb-2">
                  <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="text-sm font-medium truncate">{result.source}</span>
                  {result.score !== undefined && (
                    <Badge variant={getScoreBadgeVariant(result.score)} className="shrink-0 ml-auto">
                      {(result.score * 100).toFixed(1)}%
                    </Badge>
                  )}
                </div>
                
                {result.heading && (
                  <div className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
                    <ChevronRight className="h-3 w-3 shrink-0" />
                    <span className="truncate">{result.heading}</span>
                  </div>
                )}
                
                <p className="text-sm line-clamp-3 break-words">
                  <ContentWithWikiLinks
                    text={result.content}
                    onLinkClick={(target, heading) => {
                      const resolved = useKnowledgeStore.getState().resolveWikiLink(target)
                      if (resolved && workspacePath) {
                        selectFile(`${workspacePath}/${resolved}`, undefined, heading)
                      }
                    }}
                  />
                </p>
              </CardContent>
            </Card>
          ))}

          {!isSearching && results.length === 0 && query && (
            <div className="text-center py-8 text-muted-foreground">
              {t('knowledge.search.noResults')}
            </div>
          )}

          {!query && (
            <div className="text-center py-8 text-muted-foreground">
              {t('knowledge.search.enterQuery')}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
})

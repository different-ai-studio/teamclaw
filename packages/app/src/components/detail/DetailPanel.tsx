import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SearchResults } from './SearchResults'
import { FilePreview } from './FilePreview'
import { TerminalOutput } from './TerminalOutput'
import { McpDetail } from './McpDetail'

interface DetailPanelProps {
  content: {
    type: 'search' | 'file' | 'terminal' | 'mcp'
    data: unknown
  } | null
  onClose: () => void
}

export function DetailPanel({ content, onClose }: DetailPanelProps) {
  const { t } = useTranslation()
  if (!content) return null

  const renderContent = () => {
    switch (content.type) {
      case 'search':
        return <SearchResults data={content.data} />
      case 'file':
        return <FilePreview data={content.data} />
      case 'terminal':
        return <TerminalOutput data={content.data} />
      case 'mcp':
        return <McpDetail data={content.data} />
      default:
        return <div className="p-4 text-text-muted">{t('detail.unknownContentType', 'Unknown content type')}</div>
    }
  }

  const getTitle = () => {
    switch (content.type) {
      case 'search':
        return t('detail.searchResults', 'Search Results')
      case 'file':
        return t('detail.filePreview', 'File Preview')
      case 'terminal':
        return t('detail.terminalOutput', 'Terminal Output')
      case 'mcp':
        return t('detail.mcpToolDetails', 'MCP Tool Details')
      default:
        return t('detail.details', 'Details')
    }
  }

  return (
    <aside
      className={cn(
        'w-[400px] shrink-0 border-l border-border bg-bg-secondary',
        'flex flex-col h-full'
      )}
    >
      {/* Header */}
      <div className="h-12 flex items-center justify-between px-4 border-b border-border">
        <h3 className="font-medium text-sm">{getTitle()}</h3>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-bg-tertiary transition-colors"
        >
          <X size={18} className="text-text-muted" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {renderContent()}
      </div>
    </aside>
  )
}

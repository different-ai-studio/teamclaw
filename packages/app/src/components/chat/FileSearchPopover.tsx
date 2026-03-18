import * as React from 'react'
import { FileText, Search } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { useWorkspaceStore } from '@/stores/workspace'

export interface FileReference {
  name: string
  path: string
}

interface FileSearchPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  searchQuery: string
  onSearchChange: (query: string) => void
  onSelect: (file: FileReference) => void
}

function filterFiles(files: string[], query: string): FileReference[] {
  if (!query) return files.slice(0, 15).map(path => ({
    name: path.split('/').pop() || path,
    path,
  }))
  
  const lowerQuery = query.toLowerCase()
  return files
    .filter(path => {
      const fileName = path.split('/').pop()?.toLowerCase() || ''
      return fileName.includes(lowerQuery)
    })
    .slice(0, 15)
    .map(path => ({
      name: path.split('/').pop() || path,
      path,
    }))
}

export function FileSearchPopover({
  open,
  onOpenChange,
  searchQuery,
  onSearchChange,
  onSelect,
}: FileSearchPopoverProps) {
  const fileTree = useWorkspaceStore(s => s.fileTree)
  const flattenVisibleFileTree = useWorkspaceStore(s => s.flattenVisibleFileTree)
  const workspacePath = useWorkspaceStore(s => s.workspacePath)
  const inputRef = React.useRef<HTMLInputElement>(null)
  
  const allFiles = React.useMemo(() => {
    return flattenVisibleFileTree(fileTree)
  }, [fileTree, flattenVisibleFileTree])
  
  const filteredFiles = React.useMemo(() => {
    return filterFiles(allFiles, searchQuery)
  }, [allFiles, searchQuery])
  
  React.useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])
  
  const handleKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onOpenChange(false)
    }
  }, [onOpenChange])
  
  if (!open) return null
  
  return (
    <div 
      className="absolute bottom-full left-0 mb-2 w-80 rounded-lg border bg-popover shadow-lg z-50"
      onKeyDown={handleKeyDown}
    >
      <Command shouldFilter={false}>
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search files..."
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <CommandList className="max-h-48 overflow-y-auto">
          {!workspacePath ? (
            <div className="py-4 text-center text-sm text-muted-foreground">
              No workspace open.
            </div>
          ) : filteredFiles.length === 0 ? (
            <CommandEmpty>No files found.</CommandEmpty>
          ) : (
            <CommandGroup>
              {filteredFiles.map((file) => (
                <CommandItem
                  key={file.path}
                  value={file.path}
                  onSelect={() => {
                    onSelect(file)
                    onOpenChange(false)
                  }}
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-sm font-medium truncate">
                      {file.name}
                    </span>
                    <span className="text-xs text-muted-foreground truncate">
                      {file.path.replace(workspacePath + '/', '')}
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </div>
  )
}
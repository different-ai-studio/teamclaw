import * as React from 'react'
import { User, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { useContactsStore } from '@/stores/contacts'
import { type MentionedPerson } from '@/packages/ai/prompt-input'

export type { MentionedPerson }

interface MentionPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  searchQuery: string
  onSearchChange: (query: string) => void
  onSelect: (person: MentionedPerson) => void
}

// Filter contacts by search query
function filterContacts(contacts: MentionedPerson[], query: string): MentionedPerson[] {
  if (!query) return contacts.slice(0, 15) // Show first 15 if no query
  
  const lowerQuery = query.toLowerCase()
  return contacts
    .filter(contact => {
      const lowerName = contact.name.toLowerCase()
      const lowerEmail = contact.email?.toLowerCase() || ''
      return lowerName.includes(lowerQuery) || lowerEmail.includes(lowerQuery)
    })
    .slice(0, 15) // Limit results
}

export function MentionPopover({
  open,
  onOpenChange,
  searchQuery,
  onSearchChange,
  onSelect,
}: MentionPopoverProps) {
  const contacts = useContactsStore(s => s.contacts)
  const isLoading = useContactsStore(s => s.isLoading)
  const inputRef = React.useRef<HTMLInputElement>(null)
  
  // Focus input when popover opens
  React.useEffect(() => {
    if (open) {
      // Small delay to ensure the element is rendered
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])
  
  // Filter contacts based on search query
  const filteredContacts = React.useMemo(() => {
    return filterContacts(contacts, searchQuery)
  }, [contacts, searchQuery])
  
  // Handle keyboard events
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
            placeholder="Search people..."
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <CommandList className="max-h-48 overflow-y-auto">
          {isLoading ? (
            <div className="py-4 text-center text-sm text-muted-foreground">
              Loading contacts...
            </div>
          ) : filteredContacts.length === 0 ? (
            <CommandEmpty>No contacts found.</CommandEmpty>
          ) : (
            <CommandGroup>
              {filteredContacts.map((contact) => (
                <CommandItem
                  key={contact.id}
                  value={contact.id}
                  onSelect={() => {
                    onSelect(contact)
                    onOpenChange(false)
                  }}
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <User className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-sm font-medium truncate">
                      {contact.name}
                    </span>
                    {contact.email && (
                      <span className="text-xs text-muted-foreground truncate">
                        {contact.email}
                      </span>
                    )}
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

// Badge component for displaying mentioned people
export function MentionBadge({ 
  person, 
  onRemove,
  className,
}: { 
  person: MentionedPerson
  onRemove?: () => void
  className?: string 
}) {
  return (
    <span 
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded text-xs",
        className
      )}
    >
      <User className="h-3 w-3" />
      <span className="truncate max-w-[150px]">{person.name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="ml-0.5 hover:text-purple-900"
        >
          ×
        </button>
      )}
    </span>
  )
}

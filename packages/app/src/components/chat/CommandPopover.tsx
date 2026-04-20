import * as React from 'react'
import { Command as CommandIcon, Zap, Loader2, UserRound } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getOpenCodeClient, type Command as OpenCodeCommand } from '@/lib/opencode/sdk-client'
import { useWorkspaceStore } from '@/stores/workspace'
import { isTauri } from '@/lib/utils'
import { loadAllSkills } from '@/lib/git/skill-loader'
import { readSkillPermissions, resolveSkillPermission } from '@/lib/opencode/config'
import { loadAllRoles } from '@/lib/roles/loader'

interface CommandPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  searchQuery: string
  onSelect: (command: OpenCodeCommand) => void
}

interface SkillEntry {
  name: string
  invocationName: string
  description: string
  path: string
  permissionKey: string
}

interface RoleEntry {
  name: string
  slug: string
  description: string
}

function isSkillEntry(item: CommandOrSkill): item is SkillEntry {
  return 'invocationName' in item
}

function isRoleEntry(item: PickerItem): item is RoleEntry {
  return 'slug' in item
}

// Unified type for display in the list
type CommandOrSkill = OpenCodeCommand | SkillEntry
type PickerItem = OpenCodeCommand | SkillEntry | RoleEntry

async function scanAvailableSkills(workspacePath: string): Promise<SkillEntry[]> {
  const { skills } = await loadAllSkills(workspacePath)
  return skills
    .map((skill) => {
      const frontmatterMatch = skill.content.match(/^---\n([\s\S]*?)\n---/)
      const frontmatter = frontmatterMatch?.[1] ?? ""
      const descMatch = frontmatter.match(/^description:\s*(.+)$/m)

        return {
          name: skill.name,
          invocationName: skill.invocationName,
          description: descMatch?.[1]?.trim() || "",
          path: skill.filename,
          permissionKey: skill.invocationName,
        }
      })
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function scanAvailableRoles(workspacePath: string): Promise<RoleEntry[]> {
  const roles = await loadAllRoles(workspacePath)
  return roles
    .map((role) => ({
      name: role.name,
      slug: role.slug,
      description: role.description,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// Filter items by search query
function filterItems<T extends { name: string; description?: string }>(
  items: T[], 
  query: string, 
  limit: number = 15
): T[] {
  if (!query) return items.slice(0, limit)
  
  const lowerQuery = query.toLowerCase()
  return items
    .filter(item => {
      const lowerName = item.name.toLowerCase()
      const lowerDesc = item.description?.toLowerCase() || ''
      return lowerName.includes(lowerQuery) || lowerDesc.includes(lowerQuery)
    })
    .slice(0, limit)
}

export function CommandPopover({
  open,
  onOpenChange,
  searchQuery,
  onSelect,
}: CommandPopoverProps) {
  const workspacePath = useWorkspaceStore(s => s.workspacePath)
  const [commands, setCommands] = React.useState<OpenCodeCommand[]>([])
  const [roles, setRoles] = React.useState<RoleEntry[]>([])
  const [skills, setSkills] = React.useState<CommandOrSkill[]>([])
  const [isLoading, setIsLoading] = React.useState(false)
  const [highlightedIndex, setHighlightedIndex] = React.useState(0)
  const listRef = React.useRef<HTMLDivElement>(null)
  
  // Load commands and skills when popover opens
  React.useEffect(() => {
    if (open) {
      setIsLoading(true)
      
      // Load OpenCode commands
      const commandsPromise = getOpenCodeClient()
        .listCommands()
        .catch(error => {
          console.error('[CommandPopover] Failed to load commands:', error)
          return []
        })
      
      // Load skills from .claude/skills/ (only on Tauri)
      const skillsPromise = (isTauri() && workspacePath)
        ? scanAvailableSkills(workspacePath).catch(error => {
            console.error('[CommandPopover] Failed to scan skills:', error)
            return []
          })
        : Promise.resolve([])

      const rolesPromise = (isTauri() && workspacePath)
        ? scanAvailableRoles(workspacePath).catch(error => {
            console.error('[CommandPopover] Failed to scan roles:', error)
            return []
          })
        : Promise.resolve([])

      const permissionsPromise = workspacePath
        ? readSkillPermissions(workspacePath).catch(error => {
            console.error('[CommandPopover] Failed to load skill permissions:', error)
            return {}
          })
        : Promise.resolve({})
      
      Promise.all([commandsPromise, skillsPromise, rolesPromise, permissionsPromise])
        .then(([cmds, skls, loadedRoles, permissions]) => {
          // Separate OpenCode commands by source
          const deniedSkillNames = new Set(
            skls
              .filter((skill) => resolveSkillPermission(skill.permissionKey, permissions).permission === 'deny')
              .map((skill) => skill.name)
          )

          const allowedFrontendSkills = skls.filter(
            (skill) => resolveSkillPermission(skill.permissionKey, permissions).permission !== 'deny'
          )

          const openCodeSkills = cmds.filter((cmd) => {
            if ((cmd as OpenCodeCommand & { source?: string }).source !== 'skill') return false
            if (deniedSkillNames.has(cmd.name)) return false
            return resolveSkillPermission(cmd.name, permissions).permission !== 'deny'
          })
          const openCodeCommands = cmds.filter((cmd) => (cmd as OpenCodeCommand & { source?: string }).source !== 'skill')
          
          // Merge frontend-scanned skills with OpenCode skills
          // Deduplicate: prefer OpenCode skills (they have more metadata like template)
          const skillNameSet = new Set(openCodeSkills.map(s => s.name))
          const uniqueFrontendSkills = allowedFrontendSkills.filter(s => !skillNameSet.has(s.name))
          
          setCommands(openCodeCommands)
          setRoles(loadedRoles)
          setSkills([...openCodeSkills, ...uniqueFrontendSkills])
          setIsLoading(false)
        })
    } else {
      setRoles([])
      setSkills([])
      setCommands([])
    }
  }, [open, workspacePath])
  
  React.useEffect(() => {
    if (!open) {
      setHighlightedIndex(0)
    }
  }, [open])
  
  // Filter commands and skills based on search query
  const filteredRoles = React.useMemo(() => {
    return filterItems(roles, searchQuery, 20)
  }, [roles, searchQuery])

  const filteredSkills = React.useMemo(() => {
    return filterItems(skills, searchQuery, 20)
  }, [skills, searchQuery])
  
  const filteredCommands = React.useMemo(() => {
    return filterItems(commands, searchQuery, 20)
  }, [commands, searchQuery])
  
  // Combine all items for keyboard navigation, with type metadata
  const allItems = React.useMemo(() => {
    const rolesWithType = filteredRoles.map(r => ({ ...r, _itemType: 'role' as const }))
    const skillsWithType = filteredSkills.map(s => ({ ...s, _itemType: 'skill' as const }))
    const commandsWithType = filteredCommands.map(c => ({ ...c, _itemType: 'command' as const }))
    return [...rolesWithType, ...skillsWithType, ...commandsWithType]
  }, [filteredRoles, filteredSkills, filteredCommands])
  
  React.useEffect(() => {
    setHighlightedIndex(0)
  }, [allItems])
  
  const handleSelect = React.useCallback((item: PickerItem & { _itemType: 'role' | 'skill' | 'command' }) => {
    console.log('[CommandPopover] 🎯 handleSelect called, item:', item.name, 'type:', item._itemType);
    onSelect({
      name:
        item._itemType === 'skill' && isSkillEntry(item)
          ? item.invocationName
          : item._itemType === 'role' && isRoleEntry(item)
            ? item.slug
            : item.name,
      description: item.description,
      _type: item._itemType,
    } as OpenCodeCommand)
    console.log('[CommandPopover] ✅ onSelect called, closing popover');
    onOpenChange(false)
  }, [onSelect, onOpenChange])
  
  // Scroll highlighted item into view
  React.useEffect(() => {
    if (!listRef.current) return
    const item = listRef.current.querySelector(`[data-index="${highlightedIndex}"]`)
    item?.scrollIntoView({ block: "nearest" })
  }, [highlightedIndex])
  
  // Keyboard navigation
  React.useEffect(() => {
    if (!open || allItems.length === 0) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        e.stopPropagation()
        setHighlightedIndex(i => (i + 1) % allItems.length)
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        e.stopPropagation()
        setHighlightedIndex(i => (i - 1 + allItems.length) % allItems.length)
      } else if (e.key === "Enter" && !e.shiftKey) {
        if (e.isComposing || e.keyCode === 229) return
        e.preventDefault()
        e.stopPropagation()
        const item = allItems[highlightedIndex]
        if (item) handleSelect(item)
      }
    }

    document.addEventListener("keydown", onKeyDown, true)
    return () => document.removeEventListener("keydown", onKeyDown, true)
  }, [open, allItems, highlightedIndex, handleSelect])
  
  if (!open) return null
  
  const totalCount = filteredRoles.length + filteredSkills.length + filteredCommands.length
  const highlightedItem = allItems[highlightedIndex]
  let currentIndex = 0
  
  return (
    <div className="absolute bottom-full left-0 mb-2 rounded-lg border bg-popover shadow-lg z-50 animate-in fade-in slide-in-from-bottom-2 duration-200 flex">
      {/* Left: List */}
      <div className="w-64 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 text-[10px] text-muted-foreground border-b bg-muted/30">
          <span className="font-medium">Select role, skill, or command</span>
          {searchQuery && (
            <span className="text-[9px] text-primary font-mono">
              {searchQuery}
            </span>
          )}
          {!searchQuery && totalCount > 0 && (
            <span className="text-[9px]">
              {totalCount} items
            </span>
          )}
        </div>

        {/* List */}
        <div ref={listRef} className="max-h-80 overflow-y-auto p-1 flex-1">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading...
          </div>
        ) : totalCount === 0 ? (
          <div className="py-8 text-center text-xs text-muted-foreground">
            {searchQuery
              ? `No match for "${searchQuery}"`
              : "No skills or commands found"}
          </div>
        ) : (
          <>
            {filteredRoles.length > 0 && (
              <>
                <div className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground">
                  Roles ({filteredRoles.length})
                </div>
                {filteredRoles.map((role) => {
                  const index = currentIndex++
                  return (
                    <div
                      key={`role-${role.slug}`}
                      data-index={index}
                      onClick={() => handleSelect(allItems[index])}
                      onMouseEnter={() => setHighlightedIndex(index)}
                      className={cn(
                        "flex items-center gap-2 rounded-sm px-2 py-1.5 cursor-pointer select-none transition-colors",
                        index === highlightedIndex
                          ? "bg-accent text-accent-foreground"
                          : "text-foreground hover:bg-accent/50"
                      )}
                    >
                      <UserRound className="h-4 w-4 text-sky-600 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium truncate">
                          {role.name}
                        </div>
                        {role.slug !== role.name && (
                          <div className="text-[10px] text-muted-foreground truncate">
                            {role.slug}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </>
            )}

            {filteredSkills.length > 0 && (
              <>
                <div className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground">
                  Skills ({filteredSkills.length})
                </div>
                {filteredSkills.map((skill) => {
                  const index = currentIndex++
                  return (
                    <div
                      key={`skill-${skill.name}`}
                      data-index={index}
                      onClick={() => handleSelect(allItems[index])}
                      onMouseEnter={() => setHighlightedIndex(index)}
                      className={cn(
                        "flex items-center gap-2 rounded-sm px-2 py-1.5 cursor-pointer select-none transition-colors",
                        index === highlightedIndex
                          ? "bg-accent text-accent-foreground"
                          : "text-foreground hover:bg-accent/50"
                      )}
                    >
                      <Zap className="h-4 w-4 text-yellow-500 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium truncate">
                          {skill.name}
                        </div>
                        {isSkillEntry(skill) && skill.invocationName !== skill.name && (
                          <div className="text-[10px] text-muted-foreground truncate">
                            {skill.invocationName}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </>
            )}
            
            {filteredCommands.length > 0 && (
              <>
                <div className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground">
                  Commands ({filteredCommands.length})
                </div>
                {filteredCommands.map((cmd) => {
                  const index = currentIndex++
                  return (
                    <div
                      key={`cmd-${cmd.name}`}
                      data-index={index}
                      onClick={() => handleSelect(allItems[index])}
                      onMouseEnter={() => setHighlightedIndex(index)}
                      className={cn(
                        "flex items-center gap-2 rounded-sm px-2 py-1.5 cursor-pointer select-none transition-colors",
                        index === highlightedIndex
                          ? "bg-accent text-accent-foreground"
                          : "text-foreground hover:bg-accent/50"
                      )}
                    >
                      <CommandIcon className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="text-xs font-medium truncate">
                        /{cmd.name}
                      </div>
                    </div>
                  )
                })}
              </>
            )}
          </>
        )}
        </div>

        {/* Hint bar */}
        <div className="flex items-center gap-3 px-3 py-1.5 text-[10px] text-muted-foreground/60 border-t">
          <span><kbd className="px-1 py-0.5 rounded bg-muted text-[9px] font-mono">↑↓</kbd> navigate</span>
          <span><kbd className="px-1 py-0.5 rounded bg-muted text-[9px] font-mono">↵</kbd> select</span>
          <span><kbd className="px-1 py-0.5 rounded bg-muted text-[9px] font-mono">Esc</kbd> close</span>
        </div>
      </div>

      {/* Right: Description panel */}
      {highlightedItem && highlightedItem.description && (
        <div className="w-80 border-l bg-muted/20 flex flex-col">
          <div className="px-3 py-2 text-[10px] font-semibold text-muted-foreground border-b bg-muted/30">
            Description
          </div>
          <div className="p-3 text-[10px] text-muted-foreground leading-relaxed overflow-y-auto flex-1 max-h-80">
            {highlightedItem.description}
          </div>
        </div>
      )}
    </div>
  )
}

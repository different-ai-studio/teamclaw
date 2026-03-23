import { useState, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { ChevronRight, ChevronDown, Plus, FileText, ExternalLink, Folder, RefreshCw, Settings } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { useShortcutsStore, ShortcutNode } from "@/stores/shortcuts"
import { useTabsStore, selectActiveTab } from "@/stores/tabs"
import { useUIStore } from "@/stores/ui"
import { useWorkspaceStore } from "@/stores/workspace"
import { loadTeamShortcutsFile } from "@/lib/team-shortcuts"

interface TreeNodeProps {
  node: ShortcutNode
  level: number
  onSelect: (node: ShortcutNode) => void
  activeTarget: string | null
  openTargets: Set<string>
}

function TreeNode({ node, level, onSelect, activeTarget, openTargets }: TreeNodeProps) {
  const [isExpanded, setIsExpanded] = useState(true)
  const isActive = !!(node.target && node.target === activeTarget)
  const isOpen = !!(node.target && openTargets.has(node.target))
  const isFolder = node.type === "folder"

  const handleClick = () => {
    if (isFolder) {
      setIsExpanded(!isExpanded)
    } else {
      onSelect(node)
    }
  }

  return (
    <div>
      {isFolder ? (
        <>
          <button
            onClick={handleClick}
            className={cn(
              "w-full flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium uppercase tracking-wider",
              "text-muted-foreground/70 hover:text-muted-foreground transition-colors",
              level > 0 && "text-[10px]",
            )}
            style={{ paddingLeft: `${level * 14 + 6}px`, marginTop: level === 0 ? '6px' : '2px' }}
          >
            {isExpanded ? (
              <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />
            )}
            <span className="truncate">{node.label}</span>
          </button>
          {isExpanded && node.children && node.children.length > 0 && (
            <div>
              {node.children.map((child) => (
                <TreeNode
                  key={child.id}
                  node={child}
                  level={level + 1}
                  onSelect={onSelect}
                  activeTarget={activeTarget}
                  openTargets={openTargets}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <button
          onClick={handleClick}
          className={cn(
            "w-full flex items-center gap-2 px-2 py-[5px] text-xs rounded-md",
            "transition-colors duration-100",
            isActive
              ? "bg-primary/10 text-primary font-medium"
              : "text-foreground/80 hover:bg-muted/60 hover:text-foreground",
          )}
          style={{ paddingLeft: `${level * 14 + 10}px` }}
        >
          {node.type === "native" ? (
            <FileText className="h-3.5 w-3.5 shrink-0 opacity-50" />
          ) : (
            <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-50" />
          )}
          <span className="truncate">{node.label}</span>
          {isOpen && !isActive && (
            <span className="w-1.5 h-1.5 rounded-full bg-primary/60 shrink-0" />
          )}
        </button>
      )}
    </div>
  )
}

interface SectionHeaderProps {
  label: string
  onConfigure?: () => void
  onRefresh?: () => void
}

function SectionHeader({ label, onConfigure, onRefresh }: SectionHeaderProps) {
  const { t } = useTranslation()

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 cursor-default select-none">
          {label}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {onRefresh && (
          <ContextMenuItem onClick={onRefresh}>
            <RefreshCw className="h-3.5 w-3.5 mr-2" />
            {t("shortcuts.refreshTeam", "Refresh Team Shortcuts")}
          </ContextMenuItem>
        )}
        {onConfigure && (
          <ContextMenuItem onClick={onConfigure}>
            <Settings className="h-3.5 w-3.5 mr-2" />
            {t("shortcuts.configurePersonal", "Configure Personal Shortcuts")}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function ShortcutsPanel() {
  const { t } = useTranslation()
  const { getPersonalTree, getTeamTree, setTeamNodes } = useShortcutsStore()
  const { openSettings } = useUIStore()
  const activeTab = useTabsStore(selectActiveTab)
  const tabs = useTabsStore((s) => s.tabs)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const openTargets = useMemo(() => new Set(tabs.map((t) => t.target)), [tabs])
  const personalTree = getPersonalTree()
  const teamTree = getTeamTree()

  const activeTarget = activeTab?.target ?? null

  const handleSelectNode = (node: ShortcutNode) => {
    if (!node.target) return
    const tabType = node.type === "native" ? "native" as const : "webview" as const
    useTabsStore.getState().openTab({
      type: tabType,
      target: node.target,
      label: node.label,
    })
  }

  const handleRefreshTeam = async () => {
    if (!workspacePath) return
    const nodes = await loadTeamShortcutsFile(workspacePath)
    if (nodes) {
      setTeamNodes(nodes)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <ScrollArea className="flex-1">
        <div className="py-1 px-1.5">
          <SectionHeader
            label={t("shortcuts.personal", "PERSONAL")}
            onConfigure={openSettings}
          />
          {personalTree.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
              <Folder className="h-5 w-5 mb-1.5 opacity-20" />
              <p className="text-[11px] opacity-50">{t("settings.shortcuts.empty", "No shortcuts yet")}</p>
              <Button
                variant="ghost"
                size="sm"
                className="mt-1.5 h-6 text-[11px] gap-1 text-muted-foreground"
                onClick={() => openSettings()}
              >
                <Plus className="h-3 w-3" />
                {t("settings.shortcuts.addShortcut", "Add Shortcut")}
              </Button>
            </div>
          ) : (
            personalTree.map((node) => (
              <TreeNode
                key={node.id}
                node={node}
                level={0}
                onSelect={handleSelectNode}
                activeTarget={activeTarget}
                openTargets={openTargets}
              />
            ))
          )}

          {teamTree.length > 0 && (
            <>
              <SectionHeader
                label={t("shortcuts.team", "TEAM")}
                onConfigure={openSettings}
                onRefresh={handleRefreshTeam}
              />
              {teamTree.map((node) => (
                <TreeNode
                  key={node.id}
                  node={node}
                  level={0}
                  onSelect={handleSelectNode}
                  activeTarget={activeTarget}
                  openTargets={openTargets}
                />
              ))}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
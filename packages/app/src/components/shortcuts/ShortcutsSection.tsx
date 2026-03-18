import { useState, useEffect, useRef, useCallback } from "react"
import { useTranslation } from "react-i18next"
import {
  ChevronRight,
  ChevronDown,
  GripVertical,
  Plus,
  Trash2,
  Edit2,
  FileText,
  ExternalLink,
  Folder,
  FolderOpen,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { useShortcutsStore, ShortcutNode } from "@/stores/shortcuts"

// ── Pointer-based drag context (replaces HTML5 DnD for Tauri/WebKit compat) ──

interface DragContext {
  sourceId: string | null
  overId: string | null
  isDragging: boolean
}

// ── Tree node for settings view ─────────────────────────────────────

interface TreeNodeProps {
  node: ShortcutNode
  level: number
  onEdit: (node: ShortcutNode) => void
  onDelete: (id: string) => void
  onToggleExpand: (id: string) => void
  dragCtx: DragContext
  expandedIds: Set<string>
}

function TreeNodeItem({
  node,
  level,
  onEdit,
  onDelete,
  onToggleExpand,
  dragCtx,
  expandedIds,
}: TreeNodeProps) {
  const isFolder = node.type === "folder"
  const isExpanded = expandedIds.has(node.id)
  const isDragOver = dragCtx.overId === node.id
  const isDragSource = dragCtx.sourceId === node.id
  const children = node.children || []
  const autoExpandTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Auto-expand folder when dragging over it for 600ms
  useEffect(() => {
    if (isDragOver && isFolder && !isExpanded) {
      autoExpandTimer.current = setTimeout(() => {
        onToggleExpand(node.id)
      }, 600)
    }
    return () => {
      if (autoExpandTimer.current) {
        clearTimeout(autoExpandTimer.current)
        autoExpandTimer.current = null
      }
    }
  }, [isDragOver, isFolder, isExpanded, node.id, onToggleExpand])

  return (
    <div>
      <div
        data-shortcut-id={node.id}
        data-shortcut-type={node.type}
        className={`flex items-center gap-1.5 px-2 py-1.5 hover:bg-muted/50 rounded group transition-colors select-none ${
          isDragSource
            ? "opacity-40"
            : isDragOver && isFolder
              ? "bg-primary/10 ring-2 ring-primary/40 ring-inset"
              : isDragOver
                ? "bg-primary/10 ring-1 ring-primary/30"
                : ""
        }`}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
      >
        <GripVertical
          data-grip={node.id}
          className="h-3.5 w-3.5 text-muted-foreground cursor-grab shrink-0 touch-none"
        />

        {isFolder ? (
          <button onClick={() => onToggleExpand(node.id)} className="p-0.5 shrink-0">
            {isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}

        {(() => {
          const iconClass = "h-3.5 w-3.5 shrink-0 pointer-events-none";
          if (isFolder && isExpanded) return <FolderOpen className={`${iconClass} text-amber-500`} />;
          if (isFolder) return <Folder className={`${iconClass} text-amber-500`} />;
          if (node.type === "native") return <FileText className={`${iconClass} text-muted-foreground`} />;
          return <ExternalLink className={`${iconClass} text-muted-foreground`} />;
        })()}

        <span className="flex-1 text-sm truncate pointer-events-none">{node.label}</span>

        <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => onEdit(node)}
          >
            <Edit2 className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-destructive hover:text-destructive"
            onClick={() => onDelete(node.id)}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {isFolder && isExpanded && (
        <div>
          {children.map((child) => (
            <TreeNodeItem
              key={child.id}
              node={child}
              level={level + 1}
              onEdit={onEdit}
              onDelete={onDelete}
              onToggleExpand={onToggleExpand}
              dragCtx={dragCtx}
              expandedIds={expandedIds}
            />
          ))}
          {/* Drop zone at end of folder content */}
          <div
            data-shortcut-id={node.id}
            data-shortcut-type={node.type}
            className={`h-6 flex items-center text-[10px] text-muted-foreground/50 rounded transition-colors ${
              isDragOver ? "bg-primary/5" : ""
            }`}
            style={{ paddingLeft: `${(level + 1) * 16 + 8}px` }}
          >
            {children.length === 0 ? "Drop here" : ""}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Edit dialog ─────────────────────────────────────────────────────

type NodeType = "native" | "link" | "folder"

interface EditDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  node: ShortcutNode | null
  onSave: (data: Partial<ShortcutNode>) => void
}

function EditDialog({ open, onOpenChange, node, onSave }: EditDialogProps) {
  const { t } = useTranslation()
  const [label, setLabel] = useState(node?.label || "")
  const [type, setType] = useState<NodeType>(node?.type || "link")
  const [target, setTarget] = useState(node?.target || "")

  useEffect(() => {
    if (node) {
      setLabel(node.label)
      setType(node.type)
      setTarget(node.target)
    } else {
      setLabel("")
      setType("link")
      setTarget("")
    }
  }, [node])

  const handleSave = () => {
    onSave({ label, type, target: type === "folder" ? "" : target })
    onOpenChange(false)
  }

  const isFolder = type === "folder"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {node
              ? t("settings.shortcuts.editShortcut", "Edit Shortcut")
              : t("settings.shortcuts.addShortcut", "Add Shortcut")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">
              {t("settings.shortcuts.label", "Name")}
            </label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("settings.shortcuts.labelPlaceholder", "Enter name")}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">
              {t("settings.shortcuts.type", "Type")}
            </label>
            <Select value={type} onValueChange={(v) => setType(v as NodeType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="folder">
                  {t("settings.shortcuts.typeFolder", "Folder")}
                </SelectItem>
                <SelectItem value="link">
                  {t("settings.shortcuts.typeLink", "Link")}
                </SelectItem>
                <SelectItem value="native">
                  {t("settings.shortcuts.typeNative", "Native")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {!isFolder && (
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t("settings.shortcuts.target", "Target")}
              </label>
              <Input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder={
                  type === "native"
                    ? t("settings.shortcuts.targetNativePlaceholder", "/customers")
                    : t("settings.shortcuts.targetLinkPlaceholder", "https://...")
                }
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel", "Cancel")}
          </Button>
          <Button onClick={handleSave} disabled={!label || (!isFolder && !target)}>
            {t("common.save", "Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Main section ────────────────────────────────────────────────────

export function ShortcutsSection() {
  const { t } = useTranslation()
  const { nodes, addNode, updateNode, deleteNode, batchMove, getTree, getChildren } =
    useShortcutsStore()

  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [editingNode, setEditingNode] = useState<ShortcutNode | null>(null)
  const [addingParentId, setAddingParentId] = useState<string | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    const folderIds = new Set<string>()
    for (const n of nodes) {
      if (n.type === "folder") folderIds.add(n.id)
    }
    return folderIds
  })

  // Pointer-based drag state
  const [dragCtx, setDragCtx] = useState<DragContext>({
    sourceId: null,
    overId: null,
    isDragging: false,
  })
  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ sourceId: string; startY: number } | null>(null)

  const tree = getTree()

  // ── Pointer drag handlers (container-level) ──

  const findShortcutId = useCallback((el: Element | null): string | null => {
    while (el) {
      const id = (el as HTMLElement).dataset?.shortcutId
      if (id) return id
      el = el.parentElement
    }
    return null
  }, [])

  const executeDrop = useCallback(
    (sourceId: string, targetId: string) => {
      if (sourceId === targetId) return

      const { nodes: currentNodes, getChildren: storeGetChildren } =
        useShortcutsStore.getState()
      const sourceNode = currentNodes.find((n) => n.id === sourceId)
      const targetNode = currentNodes.find((n) => n.id === targetId)
      if (!sourceNode || !targetNode) return

      // Prevent dropping a folder into its own descendant
      if (sourceNode.type === "folder") {
        const isDescendant = (parentId: string, childId: string): boolean => {
          const children = currentNodes.filter((n) => n.parentId === parentId)
          return children.some(
            (c) => c.id === childId || isDescendant(c.id, childId),
          )
        }
        if (isDescendant(sourceId, targetId)) return
      }

      if (targetNode.type === "folder") {
        const childrenOfTarget = storeGetChildren(targetId)
        const maxOrder = childrenOfTarget.reduce(
          (max, n) => Math.max(max, n.order),
          -1,
        )
        batchMove([{ id: sourceId, parentId: targetId, order: maxOrder + 1 }])
        setExpandedIds((prev) => new Set(prev).add(targetId))
      } else {
        const parentId = targetNode.parentId
        const siblings = storeGetChildren(parentId).filter(
          (n) => n.id !== sourceId,
        )
        const targetIndex = siblings.findIndex((n) => n.id === targetId)
        siblings.splice(targetIndex + 1, 0, sourceNode)
        const moves = siblings.map((n, i) => ({
          id: n.id,
          parentId,
          order: i,
        }))
        batchMove(moves)
      }
    },
    [batchMove],
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const onPointerDown = (e: PointerEvent) => {
      // Only start drag from the grip handle
      const grip = (e.target as HTMLElement).closest("[data-grip]")
      if (!grip) return
      const id = (grip as HTMLElement).dataset.grip!
      e.preventDefault()
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      dragRef.current = { sourceId: id, startY: e.clientY }
    }

    const DRAG_THRESHOLD = 4

    const onPointerMove = (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return

      // Check threshold to start dragging
      if (!dragCtx.isDragging) {
        if (Math.abs(e.clientY - drag.startY) < DRAG_THRESHOLD) return
        setDragCtx({ sourceId: drag.sourceId, overId: null, isDragging: true })
      }

      // Find element under pointer (release capture temporarily to hit-test)
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
      const elUnder = document.elementFromPoint(e.clientX, e.clientY)
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)

      const hoverId = elUnder ? findShortcutId(elUnder) : null
      if (hoverId && hoverId !== drag.sourceId) {
        setDragCtx((prev) =>
          prev.overId === hoverId ? prev : { ...prev, overId: hoverId },
        )
      } else {
        setDragCtx((prev) =>
          prev.overId === null ? prev : { ...prev, overId: null },
        )
      }
    }

    const onPointerUp = (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      try {
        ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
      } catch {
        // ignore
      }

      // Execute the drop if we were dragging over a target
      const currentOverId = (() => {
        // Re-check element under pointer for the final drop target
        const elUnder = document.elementFromPoint(e.clientX, e.clientY)
        return elUnder ? findShortcutId(elUnder) : null
      })()

      if (currentOverId && currentOverId !== drag.sourceId) {
        executeDrop(drag.sourceId, currentOverId)
      }

      dragRef.current = null
      setDragCtx({ sourceId: null, overId: null, isDragging: false })
    }

    container.addEventListener("pointerdown", onPointerDown)
    container.addEventListener("pointermove", onPointerMove)
    container.addEventListener("pointerup", onPointerUp)
    container.addEventListener("pointercancel", onPointerUp)

    return () => {
      container.removeEventListener("pointerdown", onPointerDown)
      container.removeEventListener("pointermove", onPointerMove)
      container.removeEventListener("pointerup", onPointerUp)
      container.removeEventListener("pointercancel", onPointerUp)
    }
  }, [dragCtx.isDragging, findShortcutId, executeDrop])

  const handleEdit = (node: ShortcutNode) => {
    setEditingNode(node)
    setAddingParentId(null)
    setEditDialogOpen(true)
  }

  const handleAdd = () => {
    setEditingNode(null)
    setAddingParentId(null)
    setEditDialogOpen(true)
  }

  const handleDelete = (id: string) => {
    if (confirm(t("settings.shortcuts.confirmDelete", "Are you sure you want to delete this shortcut?"))) {
      deleteNode(id)
    }
  }

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleSave = (data: Partial<ShortcutNode>) => {
    if (editingNode) {
      updateNode(editingNode.id, data)
    } else {
      const maxOrder = getChildren(addingParentId).reduce(
        (max, n) => Math.max(max, n.order),
        -1,
      )
      addNode({
        label: data.label || "",
        type: data.type || "link",
        target: data.target || "",
        parentId: addingParentId,
        order: maxOrder + 1,
      })
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">
          {t("settings.shortcuts.title", "Shortcuts")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t(
            "settings.shortcuts.description",
            "Customize shortcut menu for quick access to common features",
          )}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={handleAdd} size="sm">
          <Plus className="h-4 w-4 mr-1" />
          {t("settings.shortcuts.addShortcut", "Add Shortcut")}
        </Button>
      </div>

      <div className="border rounded-lg">
        {tree.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground text-sm">
            {t("settings.shortcuts.empty", "No shortcuts yet")}
          </div>
        ) : (
          <div ref={containerRef} className="max-h-[400px] overflow-y-auto p-1">
              {tree.map((node) => (
                <TreeNodeItem
                  key={node.id}
                  node={node}
                  level={0}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                  onToggleExpand={handleToggleExpand}
                  dragCtx={dragCtx}
                  expandedIds={expandedIds}
                />
              ))}
          </div>
        )}
      </div>

      <EditDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        node={editingNode}
        onSave={handleSave}
      />
    </div>
  )
}

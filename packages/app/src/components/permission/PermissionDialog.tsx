import * as React from "react"
import { useTranslation } from "react-i18next"
import { Shield, AlertTriangle, FileText, Terminal, Globe, XIcon } from "lucide-react"
import * as DialogPrimitive from "@radix-ui/react-dialog"

import { useSessionStore, type PermissionAskedEvent } from "@/stores/session"
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

// Map permission types to icons and translation keys
const permissionConfig: Record<string, { icon: React.ComponentType<{ className?: string }>, color: string, labelKey: string; fallback: string }> = {
  read: { icon: FileText, color: 'text-blue-500', labelKey: 'permission.read', fallback: 'Read' },
  write: { icon: FileText, color: 'text-orange-500', labelKey: 'permission.write', fallback: 'Write' },
  edit: { icon: FileText, color: 'text-orange-500', labelKey: 'permission.edit', fallback: 'Edit' },
  bash: { icon: Terminal, color: 'text-red-500', labelKey: 'permission.execute', fallback: 'Execute' },
  execute: { icon: Terminal, color: 'text-red-500', labelKey: 'permission.execute', fallback: 'Execute' },
  share: { icon: Globe, color: 'text-purple-500', labelKey: 'permission.share', fallback: 'Share' },
  external_directory: { icon: FileText, color: 'text-amber-500', labelKey: 'permission.externalDirectory', fallback: 'External Directory' },
  skill: { icon: Terminal, color: 'text-purple-500', labelKey: 'permission.skill', fallback: 'Skill' },
}

interface PermissionDialogProps {
  permission: PermissionAskedEvent | null
  onReply: (decision: 'allow' | 'deny' | 'always') => void
}

export function PermissionDialog({ permission: permEvent, onReply }: PermissionDialogProps) {
  const { t } = useTranslation()
  const permType = permEvent?.permission || 'write'
  const config = permEvent ? permissionConfig[permType] || permissionConfig.write : permissionConfig.write
  const Icon = config.icon
  const isHighRisk = ['bash', 'execute', 'write', 'edit'].includes(permType)

  if (!permEvent) return null

  return (
    <Dialog open={!!permEvent} onOpenChange={() => onReply('deny')}>
      <DialogPortal>
        {/* Custom overlay with lighter opacity */}
        <DialogPrimitive.Overlay
          className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/20 backdrop-blur-sm"
        />
        <DialogPrimitive.Content
          className={cn(
            "bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed z-50 grid w-full max-w-[380px] gap-4 rounded-lg border p-4 shadow-lg duration-200 outline-none top-4 right-4 left-auto translate-x-0 translate-y-0"
          )}
        >
        <DialogHeader>
          <div className="flex items-center gap-2 mb-1">
            <div className={`p-1.5 rounded-lg bg-muted ${config.color}`}>
              <Shield className="h-4 w-4" />
            </div>
            <DialogTitle className="text-base">{t('permission.request', 'Permission Request')}</DialogTitle>
          </div>
          <DialogDescription className="text-left text-xs">
            <Badge variant="outline" className="mx-1 text-xs">
              <Icon className={`h-3 w-3 mr-1 ${config.color}`} />
              {t(config.labelKey, config.fallback)}
            </Badge>
            {t('permission.required', 'permission required')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-3">
          {/* Patterns (file paths affected) */}
          {permEvent.patterns && permEvent.patterns.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t('permission.affectedFiles', 'Affected files:')}</p>
              <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
                {permEvent.patterns.map((pattern, i) => (
                  <Badge key={i} variant="secondary" className="text-[10px] font-mono px-1.5 py-0.5">
                    {pattern}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Metadata */}
          {permEvent.metadata && (() => {
            const meta = permEvent.metadata as Record<string, string>
            const filePath = meta.file || meta.filepath
            return (
              <div className="space-y-2">
                {filePath ? (
                  <div className="flex items-center gap-2 text-sm">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <code className="rounded bg-muted px-2 py-0.5 text-xs">
                      {filePath}
                    </code>
                  </div>
                ) : null}
                {meta.command ? (
                  <div className="flex items-center gap-2 text-sm">
                    <Terminal className="h-4 w-4 text-muted-foreground" />
                    <code className="rounded bg-muted px-2 py-0.5 text-xs font-mono">
                      {meta.command}
                    </code>
                  </div>
                ) : null}
              </div>
            )
          })()}

          {/* Warning for high-risk operations */}
          {isHighRisk && (
            <div className="flex items-start gap-2 rounded-lg border border-yellow-200 bg-yellow-50 p-2 text-yellow-800 dark:border-yellow-900 dark:bg-yellow-950 dark:text-yellow-200">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <p className="text-[11px] leading-tight">
                {permType === 'bash'
                  ? t('permission.executeWarning', 'Executing commands may modify your system. Make sure you trust this operation.')
                  : t('permission.modifyWarning', 'This operation will modify files. Make sure you have backed up important data.')}
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="flex-col gap-1.5 sm:flex-row pt-2">
          <Button
            variant="outline"
            onClick={() => onReply('deny')}
            className="w-full sm:w-auto h-8 text-xs px-3"
          >
            {t('permission.deny', 'Deny')}
          </Button>
          <Button
            variant="outline"
            onClick={() => onReply('allow')}
            className="w-full sm:w-auto h-8 text-xs px-3"
          >
            {t('permission.allowOnce', 'Allow Once')}
          </Button>
          <Button
            onClick={() => onReply('always')}
            className="w-full sm:w-auto h-8 text-xs px-3"
          >
            {t('permission.alwaysAllow', 'Always Allow')}
          </Button>
        </DialogFooter>
        <DialogPrimitive.Close
          className="ring-offset-background focus:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute top-3 right-3 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none"
        >
          <XIcon className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}

// Wrapper component that connects to the store (not currently mounted)
export function PermissionDialogContainer() {
  const pendingPermission = useSessionStore(s => s.pendingPermission)
  const replyPermission = useSessionStore(s => s.replyPermission)

  const handleReply = React.useCallback(
    (decision: "allow" | "deny" | "always") => {
      if (pendingPermission) {
        replyPermission(pendingPermission.id, decision)
      }
    },
    [pendingPermission, replyPermission],
  )

  return (
    <PermissionDialog
      permission={pendingPermission}
      onReply={handleReply}
    />
  )
}

import * as React from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { useSessionStore } from "@/stores/session"
import type { PendingPermissionEntry, Session, ToolCallPermission } from "@/stores/session-types"

const STACK_STEP_PX = 12
const MAX_BACKPLATES = 2
const CURRENT_CARD_OFFSET_PX = STACK_STEP_PX * MAX_BACKPLATES
const CURRENT_CARD_HEIGHT_PX = 84
const BACKPLATE_HEIGHT_PX = 72
const STACK_CARD_WIDTH = "min(88vw,44rem)"
const BACKPLATE_WIDTHS = ["min(86vw,42.25rem)", "min(82vw,40rem)"] as const

type TranslateFn = (key: string, fallback?: string, options?: Record<string, unknown>) => string

function translate(
  t: ReturnType<typeof useTranslation>["t"],
  key: string,
  fallback?: string,
  options?: Record<string, unknown>,
) {
  return (t as unknown as TranslateFn)(key, fallback, options)
}

function getPermissionMeta(t: TranslateFn): Record<string, { glyph: string; title: string; subject: string }> {
  return {
    bash: { glyph: ">", title: t("chat.permissionCard.requestExecuteCommand", "请求执行命令"), subject: "Bash" },
    execute: { glyph: ">", title: t("chat.permissionCard.requestExecuteCommand", "请求执行命令"), subject: "Bash" },
    write: { glyph: "✎", title: t("chat.permissionCard.requestWriteFile", "请求写入文件"), subject: t("permission.write", "Write") },
    edit: { glyph: "✎", title: t("chat.permissionCard.requestEditFile", "请求编辑文件"), subject: t("permission.edit", "Edit") },
    read: { glyph: "📄", title: t("chat.permissionCard.requestReadFile", "请求读取文件"), subject: t("permission.read", "Read") },
    external_directory: { glyph: "📄", title: t("chat.permissionCard.requestAccessExternalPath", "请求访问外部路径"), subject: t("permission.read", "Read") },
    skill: { glyph: "⚡", title: t("chat.permissionCard.requestRunSkill", "请求运行技能"), subject: "Skill" },
  }
}

function getSourceToolLabel(t: TranslateFn, sourceToolName?: string | null) {
  if (!sourceToolName) return null
  const normalized = sourceToolName.toLowerCase()
  if (normalized.includes("bash") || normalized.includes("shell") || normalized.includes("terminal")) {
    return "Bash"
  }
  if (normalized === "write") return t("permission.write", "Write")
  if (normalized === "edit") return t("permission.edit", "Edit")
  if (normalized === "read") return t("permission.read", "Read")
  if (normalized === "skill") return "Skill"
  return sourceToolName
}

function truncateMiddle(value: string, maxLength: number, headLength: number, tailLength: number) {
  if (value.length <= maxLength) return value
  const head = value.slice(0, headLength).trimEnd()
  const tail = value.slice(-tailLength).trimStart()
  return `${head} ... ${tail}`
}

function summarizePermissionDetail(detail: string, permType: string) {
  const normalized = detail.replace(/\s+/g, " ").trim()
  if (!normalized) return detail

  if (permType === "bash" || permType === "execute") {
    return truncateMiddle(normalized, 92, 42, 24)
  }

  if (normalized.includes("/")) {
    return truncateMiddle(normalized, 88, 22, 30)
  }

  return normalized.length > 88 ? truncateMiddle(normalized, 88, 40, 20) : normalized
}

function getPermissionCardPresentation(entry: PendingPermissionEntry, t: TranslateFn) {
  const permType = entry.permission.permission || "write"
  const isExternal = permType === "external_directory"
  const permissionMeta = getPermissionMeta(t)
  const baseMeta = permissionMeta[permType] || {
    glyph: "•",
    title: t("permission.request", "请求权限"),
    subject: "Tool",
  }
  const sourceToolLabel = getSourceToolLabel(t, entry.sourceToolName)
  const meta = {
    ...baseMeta,
    subject: isExternal && sourceToolLabel ? sourceToolLabel : baseMeta.subject,
  }

  const metadata = entry.permission.metadata as Record<string, string> | undefined
  const commandText = entry.permission.patterns?.join(" ") || ""
  const filePath = metadata?.file || metadata?.filepath || ""
  const skillName = metadata?.skill || metadata?.name || ""
  const firstPattern = entry.permission.patterns?.[0] || ""

  const detail = (() => {
    if (permType === "bash" || permType === "execute") {
      return commandText || firstPattern || permType
    }
    if (filePath) {
      return filePath
    }
    if (permType === "skill") {
      return skillName || firstPattern || t("chat.permissionCard.requestedSkill", "Requested skill")
    }
    if (firstPattern) {
      return firstPattern
    }
    return permType
  })()

  const subtitle = isExternal
    ? sourceToolLabel
      ? t("chat.permissionCard.sourceToolInvocation", "来自 {{tool}} 工具调用", { tool: sourceToolLabel })
      : t("chat.permissionCard.waitingExternalPathApproval", "读取工作区外路径前需要你的确认")
    : entry.childSessionId
      ? t("chat.permissionCard.childSessionWaitingApproval", "子会话正在等待你的审批")
      : sourceToolLabel
        ? t("chat.permissionCard.sourceToolInvocation", "来自 {{tool}} 工具调用", { tool: sourceToolLabel })
        : t("chat.permissionCard.toolInvocationWaitingApproval", "工具调用正在等待你的审批")

  return { meta, detail: summarizePermissionDetail(detail, permType), subtitle }
}

function buildPendingEntryFromToolPermission(
  permission: ToolCallPermission,
  sessionId: string,
  sourceToolName?: string | null,
  sourceToolCallId?: string | null,
): PendingPermissionEntry {
  return {
    permission: {
      id: permission.id,
      sessionID: sessionId,
      permission: permission.permission,
      patterns: permission.patterns,
      metadata: permission.metadata as Record<string, string> | undefined,
      always: permission.always,
    },
    childSessionId: null,
    sourceToolName: sourceToolName ?? null,
    sourceToolCallId: sourceToolCallId ?? null,
  }
}

function collectToolPendingPermissions(session: Session | null): PendingPermissionEntry[] {
  if (!session) return []

  const collected: PendingPermissionEntry[] = []
  for (const message of session.messages) {
    for (const toolCall of message.toolCalls || []) {
      const permission = toolCall.permission
      if (!permission) continue
      if (permission.decision !== "pending") continue
      if (toolCall.status !== "calling" && toolCall.status !== "waiting") continue
      collected.push(buildPendingEntryFromToolPermission(permission, session.id, toolCall.name, toolCall.id))
    }
  }

  return collected
}

function collectVisiblePermissions(
  activeSessionId: string | null,
  sessions: Session[],
  pendingPermissions: PendingPermissionEntry[],
): PendingPermissionEntry[] {
  const activeSession = activeSessionId
    ? sessions.find((session) => session.id === activeSessionId) || null
    : null

  const toolPermissions = collectToolPendingPermissions(activeSession)
  const merged = [...toolPermissions, ...pendingPermissions]
  const seen = new Set<string>()

  return merged.filter((entry) => {
    if (seen.has(entry.permission.id)) return false
    seen.add(entry.permission.id)
    return true
  })
}

function PermissionEntryCard({
  entry,
  pendingCount,
  onReplyStart,
  onReplyRollback,
}: {
  entry: PendingPermissionEntry
  pendingCount: number
  onReplyStart?: (permissionId: string) => void
  onReplyRollback?: (permissionId: string) => void
}) {
  const { t: i18nT } = useTranslation()
  const t = React.useCallback<TranslateFn>((key, fallback, options) => {
    return translate(i18nT, key, fallback, options)
  }, [i18nT])
  const replyPermission = useSessionStore((s) => s.replyPermission)
  const [submitting, setSubmitting] = React.useState(false)
  const [decided, setDecided] = React.useState<string | null>(null)

  const prevPermIdRef = React.useRef<string | null>(null)
  if (entry.permission.id !== prevPermIdRef.current) {
    prevPermIdRef.current = entry.permission.id
    if (decided !== null) setDecided(null)
  }

  const { meta, detail, subtitle } = getPermissionCardPresentation(entry, t)

  const handleReply = async (d: "allow" | "deny" | "always") => {
    setSubmitting(true)
    setDecided(d)
    onReplyStart?.(entry.permission.id)
    try {
      await replyPermission(entry.permission.id, d)
    } catch (error) {
      setDecided(null)
      onReplyRollback?.(entry.permission.id)
      throw error
    } finally {
      setSubmitting(false)
    }
  }

  const isPending = decided === null
  if (!isPending) return null

  return (
    <div className="pointer-events-auto">
      <div
        data-testid="pending-permission-card"
        className="h-[84px] w-full overflow-hidden rounded-[16px] border border-border/70 bg-card animate-in fade-in zoom-in-95 slide-in-from-bottom-4 duration-250 motion-reduce:animate-none"
      >
        <div className="px-3.5 py-2">
          <div className="flex h-full items-start gap-3">
            <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-[9px] border border-[#e5eaf0] bg-[#f8fafc] text-[#64748b] dark:border-border dark:bg-muted dark:text-foreground">
              <span className="text-[12px]">{meta.glyph}</span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-[13px] font-semibold text-foreground">{meta.subject} {meta.title}</div>
                {pendingCount > 1 ? (
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {t("chat.permissionCard.pendingCount", "{{count}} pending", { count: pendingCount })}
                  </span>
                ) : null}
              </div>
              <div
                className="mt-0.5 overflow-hidden text-[12px] leading-5 text-foreground/85"
                style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}
              >
                {detail}
              </div>
              <div className="truncate text-[11px] leading-5 text-muted-foreground">{subtitle}</div>
            </div>
            {isPending ? (
              <div
                data-testid="pending-permission-actions"
                className="ml-auto flex shrink-0 items-center gap-2 self-start pt-0.5"
              >
                <button
                  type="button"
                  onClick={() => handleReply("deny")}
                  disabled={submitting}
                  className="shrink-0 rounded-[9px] border border-[#e5eaf0] bg-white px-[10px] py-[5px] text-[12px] font-medium text-[#475569] transition-colors hover:bg-muted/70 hover:text-foreground disabled:opacity-50 dark:border-border dark:bg-background dark:text-muted-foreground"
                >
                  {t("permission.deny", "拒绝")}
                </button>
                <button
                  type="button"
                  onClick={() => handleReply("always")}
                  disabled={submitting}
                  className="shrink-0 rounded-[9px] border border-[#e5eaf0] bg-white px-[10px] py-[5px] text-[12px] font-medium text-[#475569] transition-colors hover:bg-muted/70 hover:text-foreground disabled:opacity-50 dark:border-border dark:bg-background dark:text-muted-foreground"
                >
                  {t("permission.alwaysAllow", "总是允许")}
                </button>
                <button
                  type="button"
                  onClick={() => handleReply("allow")}
                  disabled={submitting}
                  className="shrink-0 rounded-[9px] bg-[#111827] px-[10px] py-[5px] text-[12px] font-semibold text-white transition-colors hover:bg-primary/90 disabled:opacity-50 dark:bg-primary"
                >
                  {t("chat.permissionCard.approve", "允许")}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Unified permission approval stack rendered above the input area.
 * Includes both tool-attached permissions from the active session and
 * child-session/floating permissions queued in the global store.
 */
export function PendingPermissionInline() {
  const { t: i18nT } = useTranslation()
  const t = React.useCallback<TranslateFn>((key, fallback, options) => {
    return translate(i18nT, key, fallback, options)
  }, [i18nT])
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const sessions = useSessionStore((s) => s.sessions)
  const pendingPermissions = useSessionStore((s) => s.pendingPermissions)
  const [dismissedIds, setDismissedIds] = React.useState<string[]>([])

  const baseVisiblePermissions = React.useMemo(
    () => collectVisiblePermissions(activeSessionId, sessions, pendingPermissions),
    [activeSessionId, pendingPermissions, sessions],
  )

  React.useEffect(() => {
    setDismissedIds((current) => current.filter((id) => baseVisiblePermissions.some((entry) => entry.permission.id === id)))
  }, [baseVisiblePermissions])

  const visiblePermissions = React.useMemo(
    () => baseVisiblePermissions.filter((entry) => !dismissedIds.includes(entry.permission.id)),
    [baseVisiblePermissions, dismissedIds],
  )

  if (visiblePermissions.length === 0) return null

  const currentEntry = visiblePermissions[0]
  const queuedCount = visiblePermissions.length
  const backplateCount = Math.min(Math.max(queuedCount - 1, 0), MAX_BACKPLATES)
  const currentOffset = CURRENT_CARD_OFFSET_PX
  const stackHeight = currentOffset + CURRENT_CARD_HEIGHT_PX

  return (
    <div
      data-testid="pending-permission-inline"
      className="relative z-0 mx-auto mb-0 mt-0 flex w-[min(92vw,48rem)] justify-center"
    >
      <div className="w-full px-0">
        <div className="relative" style={{ minHeight: stackHeight }}>
          {Array.from({ length: backplateCount }).map((_, index) => {
            const queuedEntry = visiblePermissions[index + 1]
            const presentation = queuedEntry ? getPermissionCardPresentation(queuedEntry, t) : null
            const bottom = (backplateCount - index) * STACK_STEP_PX

            return (
              <div
                key={`backplate-${index}`}
                data-testid="pending-permission-backplate"
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute left-1/2 overflow-hidden rounded-[16px] border transition-all duration-300 ease-out",
                  index === 0 && "border-border/60 bg-card opacity-70",
                  index === 1 && "border-border/65 bg-card opacity-84",
                )}
                style={{
                  bottom: `${bottom}px`,
                  width: BACKPLATE_WIDTHS[index] ?? STACK_CARD_WIDTH,
                  transform: "translateX(-50%)",
                  height: `${BACKPLATE_HEIGHT_PX}px`,
                }}
              >
                {presentation ? (
                  <div className="flex h-full items-start gap-3 px-3.5 py-2">
                    <div className="flex h-6 w-6 items-center justify-center rounded-[8px] border border-[#e5eaf0] bg-[#f8fafc] text-[#64748b] dark:border-border dark:bg-muted dark:text-foreground">
                      <span className="text-[12px]">{presentation.meta.glyph}</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] text-foreground/90">
                        <strong>{presentation.meta.subject}</strong> {presentation.meta.title}
                      </div>
                      {index === 0 ? (
                        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {presentation.subtitle}
                        </div>
                      ) : null}
                      <div className="truncate text-[11px] leading-5 text-muted-foreground/90">
                        {presentation.detail}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            )
          })}
          <div
            data-testid="pending-permission-current"
            className="absolute bottom-0 left-1/2 z-[1] transition-all duration-300 ease-out"
            style={{ width: STACK_CARD_WIDTH, transform: "translateX(-50%)" }}
          >
            <PermissionEntryCard
              entry={currentEntry}
              pendingCount={queuedCount}
              onReplyStart={(permissionId) => {
                setDismissedIds((current) => current.includes(permissionId) ? current : [...current, permissionId])
              }}
              onReplyRollback={(permissionId) => {
                setDismissedIds((current) => current.filter((id) => id !== permissionId))
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

import * as React from "react";
import { useTranslation } from 'react-i18next';
import { FileText, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputTextarea,
  PromptInputTools,
  PromptInputSubmit,
  usePromptInputContext,
  useInsertSkillMention,
  useInsertPageLink,
  type PromptInputMessage,
} from "@/packages/ai/prompt-input";
import { textHasMemberMentionTokens } from "@/lib/member-mention-token";
import {
  createInsertHashFile,
  createInsertFileMention,
  createInsertMention,
  createInsertAgentMention,
  type AttachedAgent,
} from "@/packages/ai/prompt-input-insert-hooks";
import { FileMentionPopover } from "./FileMentionPopover";
import { MentionPopover } from "./MentionPopover";
import { AgentSelectorDock } from "./AgentSelectorDock";
import { EngagedAgentOfflineBanner } from "./EngagedAgentOfflineBanner";
import { OfflineSendConfirmDialog } from "./OfflineSendConfirmDialog";
import type { EngagedAgentUiEntry } from "@/hooks/use-engaged-agent-ui-states";
import { hasAnyNonReadyEngaged } from "@/hooks/use-engaged-agent-ui-states";
import { useOfflineSendPreferenceStore } from "@/stores/offline-send-preference-store";
import { ComposerStack, type ActiveStreamingAgent } from "./ComposerStack";
import type { Todo } from "@/stores/session-types";
import { CommandPopover } from "./CommandPopover";
import type { Command as ChatCommand } from "./CommandPopover";
import { FileInputButton } from "./FileInputButton";
import { ContextUsageBadge } from "./ContextUsageBadge";
import { PermissionApprovalModeSelect } from "./PermissionApprovalModeSelect";
import { type QueuedMessage, useSessionStore } from "@/stores/session";
import { useVoiceInputStore } from "@/stores/voice-input";
import { useWorkspaceStore } from "@/stores/workspace";
import { useUIStore } from "@/stores/ui";
import { isImageFile } from "@/lib/attachment-constants";
import type { SessionAttachmentRef } from "@/lib/session-attachments";
import { exceedsNonImageLimit } from "@/lib/attachment-constants";

// ─── Popover wrappers (need PromptInput context for useInsertFileMention) ───

function FileMentionPopoverWrapper({
  activeSessionId,
  open,
  onOpenChange,
  searchQuery,
  onSearchChange,
  useHashTrigger,
  onSelectSessionAttachment,
}: {
  activeSessionId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  useHashTrigger: boolean;
  onSelectSessionAttachment: (attachment: SessionAttachmentRef) => void;
}) {
  const context = usePromptInputContext();
  const insertFileMention = React.useMemo(
    () => useHashTrigger ? createInsertHashFile(context) : createInsertFileMention(context),
    [context, useHashTrigger],
  );

  return (
    <FileMentionPopover
      activeSessionId={activeSessionId}
      open={open}
      onOpenChange={onOpenChange}
      searchQuery={searchQuery}
      onSearchChange={onSearchChange}
      onSelect={insertFileMention}
      onSelectSessionAttachment={onSelectSessionAttachment}
    />
  );
}

function MentionPopoverWrapper({
  open,
  onOpenChange,
  searchQuery,
  engagedAgents,
  onEngageAgent,
  onRemoveAgent,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  searchQuery: string;
  engagedAgents: AttachedAgent[];
  onEngageAgent: (agent: AttachedAgent) => void;
  onRemoveAgent: (agentId: string) => void;
}) {
  const context = usePromptInputContext();
  const insertMember = React.useMemo(() => createInsertMention(context), [context]);
  const insertAgent = React.useMemo(
    () => createInsertAgentMention(context, onEngageAgent),
    [context, onEngageAgent],
  );
  const engagedAgent = engagedAgents[0] ?? null;
  return (
    <MentionPopover
      open={open}
      onOpenChange={onOpenChange}
      searchQuery={searchQuery}
      engagedAgent={engagedAgent}
      onSelectMember={(person, options) => {
        if (options?.clearEngagedAgent && engagedAgent) {
          onRemoveAgent(engagedAgent.id);
        }
        insertMember(person);
      }}
      onSelectAgent={(agent) => insertAgent(agent)}
    />
  );
}

function CommandPopoverWrapper({
  activeSessionId,
  open,
  onOpenChange,
  searchQuery,
}: {
  activeSessionId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  searchQuery: string;
}) {
  const insertSkillMention = useInsertSkillMention();

  const handleSelect = React.useCallback((command: ChatCommand & { _type?: 'role' | 'skill' | 'command' }) => {
    console.log('[CommandPopoverWrapper] 🎯 handleSelect called, command:', command.name, 'type:', command._type);
    const type = command._type || 'skill'; // Default to skill for backward compatibility
    insertSkillMention(command.name, type);
    console.log('[CommandPopoverWrapper] ✅ insertSkillMention called');
    onOpenChange(false);
  }, [insertSkillMention, onOpenChange]);

  return (
    <CommandPopover
      activeSessionId={activeSessionId}
      open={open}
      onOpenChange={onOpenChange}
      searchQuery={searchQuery}
      onSelect={handleSelect}
    />
  );
}

// ─── Feature flag: gates the @/# swap introduced in the mention-redesign ────
const REDESIGN_ON = import.meta.env.VITE_MENTION_REDESIGN !== 'false';

// ─── Main input area ────────────────────────────────────────────────────────

interface ChatInputAreaProps {
  activeSessionId: string | null;
  compact: boolean;
  inputValue: string;
  onInputChange: (v: string) => void;
  pendingFiles: File[];
  onAppendPendingFiles: (files: File[]) => void;
  onRemovePendingFile: (index: number) => void;
  referencedAttachments: SessionAttachmentRef[];
  onAppendReferencedAttachment: (attachment: SessionAttachmentRef) => void;
  onRemoveReferencedAttachment: (index: number) => void;
  onSubmit: (message: PromptInputMessage) => void;
  /** When true, placeholder suggests queuing another message while agents run. */
  isStreaming: boolean;
  messageQueue: QueuedMessage[];
  onRemoveFromQueue: (id: string) => void;
  onHeightChange?: (height: number) => void;
  /** Called when the composer editor receives focus (used to pause scroll follow while reading). */
  onComposerFocus?: () => void;
  bottomOffsetPx?: number;
  /** Plan + queue rows rendered inside the unified composer stack (above input). */
  stackTodos?: Todo[];
  stackQueue?: QueuedMessage[];
  planSlotHidden?: boolean;
  engagedAgents: AttachedAgent[];
  engagedUiEntries?: EngagedAgentUiEntry[];
  agentToRuntimeId?: Map<string, string>;
  agentToBackendType?: Map<string, string>;
  localDaemonAgent?: AttachedAgent | null;
  onSwitchToLocalAgent?: (agent: AttachedAgent) => void;
  onRetryOfflineAgents?: () => void;
  onEngageAgent: (agent: AttachedAgent) => void;
  onRemoveAgent: (agentId: string) => void;
  /** Solo (1 human + 1 agent): pill is always on and cannot be removed. */
  agentMentionLocked?: boolean;
  activeStreamingAgents?: ReadonlyArray<ActiveStreamingAgent>;
  onInterruptAgent?: (agentId: string) => void;
}

function ComposerSubmitButton({
  inputValue,
  pendingFiles,
  referencedAttachments,
}: {
  inputValue: string;
  pendingFiles: File[];
  referencedAttachments: SessionAttachmentRef[];
}) {
  const { mentions } = usePromptInputContext();
  const canSend =
    Boolean(inputValue.trim()) ||
    pendingFiles.length > 0 ||
    referencedAttachments.length > 0 ||
    mentions.length > 0 ||
    textHasMemberMentionTokens(inputValue);

  return <PromptInputSubmit disabled={!canSend} />;
}

function PageLinkInsertBridge() {
  const insertPageLink = useInsertPageLink();
  const pageLinkInsertRequestId = useUIStore((s) => s.pageLinkInsertRequestId);
  const pendingPageLink = useUIStore((s) => s.pendingPageLinkInsert);
  const insertRef = React.useRef(insertPageLink);
  insertRef.current = insertPageLink;
  const consumedRequestIdRef = React.useRef(0);

  React.useEffect(() => {
    if (pageLinkInsertRequestId <= 0) return;
    if (pageLinkInsertRequestId === consumedRequestIdRef.current) return;
    if (!pendingPageLink) return;
    consumedRequestIdRef.current = pageLinkInsertRequestId;
    insertRef.current(pendingPageLink);
  }, [pageLinkInsertRequestId, pendingPageLink]);

  return null;
}

export function ChatInputArea({
  activeSessionId,
  compact,
  inputValue,
  onInputChange,
  pendingFiles,
  onAppendPendingFiles,
  onRemovePendingFile,
  referencedAttachments,
  onAppendReferencedAttachment,
  onRemoveReferencedAttachment,
  onSubmit,
  isStreaming,
  messageQueue: _messageQueue,
  onRemoveFromQueue: _onRemoveFromQueue,
  onHeightChange,
  onComposerFocus,
  bottomOffsetPx = 0,
  stackTodos = [],
  stackQueue = [],
  planSlotHidden = false,
  engagedAgents = [],
  engagedUiEntries = [],
  agentToRuntimeId = new Map(),
  agentToBackendType = new Map(),
  localDaemonAgent = null,
  onSwitchToLocalAgent,
  onRetryOfflineAgents,
  onEngageAgent = () => {},
  onRemoveAgent = () => {},
  agentMentionLocked = false,
  activeStreamingAgents = [],
  onInterruptAgent,
}: ChatInputAreaProps) {
  const { t } = useTranslation();

  // # file reference states
  const [filePopoverOpen, setFilePopoverOpen] = React.useState(false);
  const [hashSearchQuery, setHashSearchQuery] = React.useState("");

  // @ mention states
  const [mentionPopoverOpen, setMentionPopoverOpen] = React.useState(false);
  const [mentionSearchQuery, setMentionSearchQuery] = React.useState("");

  // / command states
  const [commandPopoverOpen, setCommandPopoverOpen] = React.useState(false);
  const [commandSearchQuery, setCommandSearchQuery] = React.useState("");

  // v2: Plan mode removed.

  // Handle file paths dropped from file tree - insert as @{filepath} mention (same as "Add to Agent")
  const handleFilePathsDrop = React.useCallback((paths: string[]) => {
    const wsPath = useWorkspaceStore.getState().workspacePath;
    for (const path of paths) {
      let displayPath = path;
      if (wsPath && path.startsWith(wsPath)) {
        displayPath = path.slice(wsPath.length + 1);
      }
      // Read current text inside loop — draftInput updates after each insertToChat
      const currentText = useSessionStore.getState().draftInput;
      if (currentText.includes(`@{${displayPath}}`)) continue;
      const mention = `@{${displayPath}} `;
      useVoiceInputStore.getState().insertToChat(mention);
    }
  }, []);

  const handleIncomingFiles = React.useCallback((files: File[]) => {
    const accepted = files.filter((f) => !exceedsNonImageLimit(f));
    const oversize = files.filter((f) => exceedsNonImageLimit(f)).map((f) => f.name);
    if (oversize.length > 0) {
      void import("sonner").then(({ toast }) => {
        toast.error(
          oversize.length === 1
            ? `"${oversize[0]}" exceeds the 20MB limit`
            : `${oversize.length} files exceed the 20MB limit`,
        );
      });
    }
    if (accepted.length > 0) {
      onAppendPendingFiles(accepted);
    }
  }, [onAppendPendingFiles]);

  const handleSelectSessionAttachment = React.useCallback(
    (attachment: SessionAttachmentRef) => {
      onAppendReferencedAttachment(attachment);
      setFilePopoverOpen(false);
      setHashSearchQuery("");
    },
    [onAppendReferencedAttachment],
  );

  const imagePreviewUrls = React.useMemo(() => {
    return pendingFiles.filter(isImageFile).map((file) => URL.createObjectURL(file));
  }, [pendingFiles]);

  // Revoke preview URLs on cleanup
  React.useEffect(() => {
    return () => {
      imagePreviewUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [imagePreviewUrls]);

  const [offlineConfirmOpen, setOfflineConfirmOpen] = React.useState(false);
  const [pendingSubmitMessage, setPendingSubmitMessage] =
    React.useState<PromptInputMessage | null>(null);
  const [dismissConfirmChecked, setDismissConfirmChecked] = React.useState(false);
  const offlineDismissed = useOfflineSendPreferenceStore((s) =>
    activeSessionId ? !!s.dismissedBySession[activeSessionId] : false,
  );

  const flushSubmit = React.useCallback(
    (message: PromptInputMessage) => {
      if (dismissConfirmChecked && activeSessionId) {
        useOfflineSendPreferenceStore.getState().dismissForSession(activeSessionId);
      }
      setOfflineConfirmOpen(false);
      setPendingSubmitMessage(null);
      setDismissConfirmChecked(false);
      onSubmit(message);
    },
    [onSubmit, dismissConfirmChecked, activeSessionId],
  );

  const handleSubmit = React.useCallback(
    (message: PromptInputMessage) => {
      const needsConfirm =
        engagedUiEntries.length > 0 &&
        hasAnyNonReadyEngaged(engagedUiEntries) &&
        activeSessionId &&
        !offlineDismissed;
      if (needsConfirm) {
        setPendingSubmitMessage(message);
        setOfflineConfirmOpen(true);
        return;
      }
      onSubmit(message);
    },
    [onSubmit, engagedUiEntries, activeSessionId, offlineDismissed],
  );

  // Measure height and report to parent via ResizeObserver
  // Round to nearest integer to prevent sub-pixel oscillation feedback loops
  const rootRef = React.useRef<HTMLDivElement>(null);
  const lastReportedHeight = React.useRef(0);
  const composerFocusRequestId = useUIStore((s) => s.composerFocusRequestId);
  React.useEffect(() => {
    if (composerFocusRequestId <= 0) return;
    requestAnimationFrame(() => {
      const editor = rootRef.current?.querySelector<HTMLElement>(
        '[data-testid="v2-composer-editor"]',
      );
      editor?.focus();
    });
  }, [composerFocusRequestId]);

  React.useEffect(() => {
    if (!onComposerFocus) return;
    const root = rootRef.current;
    if (!root) return;
    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (!target.closest('[data-testid="v2-composer-editor"]')) return;
      onComposerFocus();
    };
    root.addEventListener("focusin", handleFocusIn);
    return () => root.removeEventListener("focusin", handleFocusIn);
  }, [onComposerFocus]);

  React.useEffect(() => {
    const el = rootRef.current;
    if (!el || !onHeightChange) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const raw = entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height;
        const rounded = Math.round(raw);
        if (rounded !== lastReportedHeight.current) {
          lastReportedHeight.current = rounded;
          onHeightChange(rounded);
        }
      }
    });
    ro.observe(el);
    const initial = Math.round(el.getBoundingClientRect().height);
    lastReportedHeight.current = initial;
    onHeightChange(initial);
    return () => ro.disconnect();
  }, [onHeightChange]);

  return (
    <div
      ref={rootRef}
      data-testid="chat-input-area"
      style={bottomOffsetPx ? { bottom: bottomOffsetPx } : undefined}
      className={cn(
        "z-20",
        compact
          ? "absolute bottom-0 left-0 right-0 px-2 pb-2 pt-2 bg-background"
          : "absolute bottom-0 left-0 right-0 bg-gradient-to-t from-background from-[42%] via-background/92 to-transparent px-4 pb-6 pt-8",
      )}
    >
      <div className={cn("relative z-10 w-full", compact ? "" : "mx-auto max-w-3xl")}>
        {!compact ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 -bottom-7 -z-10 bg-background"
          />
        ) : null}
        <ComposerStack
          agents={onInterruptAgent ? activeStreamingAgents : []}
          onInterrupt={onInterruptAgent}
          todos={stackTodos}
          queue={stackQueue}
          onRemoveFromQueue={_onRemoveFromQueue}
          planSlotHidden={planSlotHidden}
        >
          <PromptInput
            value={inputValue}
            onValueChange={onInputChange}
            onSubmit={handleSubmit}
            onFilesChange={handleIncomingFiles}
            onFilePathsDrop={handleFilePathsDrop}
            onHashTrigger={REDESIGN_ON ? (query) => {
              setHashSearchQuery(query);
              setFilePopoverOpen(true);
            } : undefined}
            onHashClose={REDESIGN_ON ? () => {
              setFilePopoverOpen(false);
              setHashSearchQuery("");
            } : undefined}
            onMentionTrigger={REDESIGN_ON
              ? (query) => { setMentionSearchQuery(query); setMentionPopoverOpen(true); }
              : (query) => { setHashSearchQuery(query); setFilePopoverOpen(true); }
            }
            onMentionClose={REDESIGN_ON
              ? () => { setMentionPopoverOpen(false); setMentionSearchQuery(""); }
              : () => { setFilePopoverOpen(false); setHashSearchQuery(""); }
            }
            onCommandTrigger={(query) => {
              setCommandSearchQuery(query);
              setCommandPopoverOpen(true);
            }}
            onCommandClose={() => {
              setCommandPopoverOpen(false);
              setCommandSearchQuery("");
            }}
            multiple
            className="relative z-10 w-full"
          >
          <PageLinkInsertBridge />
          {/* Agent chips: removed — agent is shown in AgentSelectorDock (bottom-left) instead */}

          {(pendingFiles.length > 0 || referencedAttachments.length > 0) && (
            <div className="flex flex-wrap gap-2 px-4 pt-3 pb-2">
              {pendingFiles.map((file, index) => {
                if (isImageFile(file)) {
                  const previewIndex = pendingFiles
                    .slice(0, index + 1)
                    .filter(isImageFile).length - 1;
                  return (
                    <div key={`pending-img-${file.name}-${index}`} className="relative group">
                      <div className="relative size-12 rounded border bg-muted/50 overflow-hidden">
                        <img
                          src={imagePreviewUrls[previewIndex]}
                          alt={file.name}
                          className="h-full w-full object-cover"
                        />
                        <button
                          type="button"
                          onClick={() => onRemovePendingFile(index)}
                          className="absolute top-0 right-0 p-0.5 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </div>
                      <span className="block text-[9px] text-muted-foreground truncate max-w-12 mt-0.5 text-center">
                        {file.name}
                      </span>
                    </div>
                  );
                }

                return (
                  <div
                    key={`pending-file-${file.name}-${index}`}
                    title={file.name}
                    className="relative group flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border bg-muted/50 min-w-0 max-w-[280px]"
                  >
                    <FileText className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                    <span className="text-xs font-medium truncate leading-tight">{file.name}</span>
                    <button
                      type="button"
                      onClick={() => onRemovePendingFile(index)}
                      className="ml-0.5 p-0.5 flex-shrink-0 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}

              {referencedAttachments.map((attachment, index) => (
                <div
                  key={`ref-${attachment.url}`}
                  title={attachment.url}
                  className="relative group flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-dashed bg-muted/30 min-w-0 max-w-[280px]"
                >
                  <FileText className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                  <span className="text-xs font-medium truncate leading-tight">{attachment.name}</span>
                  <span className="text-[10px] text-muted-foreground flex-shrink-0">#</span>
                  <button
                    type="button"
                    onClick={() => onRemoveReferencedAttachment(index)}
                    className="ml-0.5 p-0.5 flex-shrink-0 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {engagedUiEntries.length > 0 ? (
            <EngagedAgentOfflineBanner
              entries={engagedUiEntries}
              localDaemonAgent={localDaemonAgent}
              onRemoveAgent={onRemoveAgent}
              onSwitchToLocalAgent={onSwitchToLocalAgent}
              onRetryOffline={onRetryOfflineAgents}
              agentMentionLocked={agentMentionLocked}
            />
          ) : null}

          <PromptInputBody>
            <PromptInputTextarea
              placeholder={
                isStreaming
                  ? t('chat.inputPlaceholderContinue', 'Continue typing...')
                  : pendingFiles.length > 0 || referencedAttachments.length > 0
                    ? t('chat.inputPlaceholderDescription', 'Add a description...')
                    : t('chat.inputPlaceholderMention', 'Mention with @, reference files with #...')
              }
            />
          </PromptInputBody>

          {/* Popovers (inside PromptInput for context) */}
          <FileMentionPopoverWrapper
            activeSessionId={activeSessionId}
            open={filePopoverOpen}
            onOpenChange={setFilePopoverOpen}
            searchQuery={hashSearchQuery}
            onSearchChange={setHashSearchQuery}
            useHashTrigger={REDESIGN_ON}
            onSelectSessionAttachment={handleSelectSessionAttachment}
          />
          {REDESIGN_ON && (
            <MentionPopoverWrapper
              open={mentionPopoverOpen}
              onOpenChange={setMentionPopoverOpen}
              searchQuery={mentionSearchQuery}
              engagedAgents={engagedAgents}
              onEngageAgent={onEngageAgent}
              onRemoveAgent={onRemoveAgent}
            />
          )}
          <CommandPopoverWrapper
            activeSessionId={activeSessionId}
            open={commandPopoverOpen}
            onOpenChange={setCommandPopoverOpen}
            searchQuery={commandSearchQuery}
          />

          <PromptInputFooter>
            <PromptInputTools>
              <FileInputButton onFilesSelected={handleIncomingFiles} />
              <PermissionApprovalModeSelect sessionId={activeSessionId} />

              {/* Engaged agent pills — model is chosen per agent on each pill. */}
              <AgentSelectorDock
                activeSessionId={activeSessionId}
                engagedAgents={engagedAgents}
                engagedUiEntries={engagedUiEntries}
                agentToRuntimeId={agentToRuntimeId}
                agentToBackendType={agentToBackendType}
                onRemoveAgent={onRemoveAgent}
                agentMentionLocked={agentMentionLocked}
              />
            </PromptInputTools>

            <div className="flex shrink-0 items-center gap-2">
              <ContextUsageBadge />
              <ComposerSubmitButton
                inputValue={inputValue}
                pendingFiles={pendingFiles}
                referencedAttachments={referencedAttachments}
              />
            </div>
          </PromptInputFooter>
          </PromptInput>

          <OfflineSendConfirmDialog
            open={offlineConfirmOpen}
            onOpenChange={(open) => {
              setOfflineConfirmOpen(open);
              if (!open) setPendingSubmitMessage(null);
            }}
            entries={engagedUiEntries}
            dismissForSession={dismissConfirmChecked}
            onDismissForSessionChange={setDismissConfirmChecked}
            onConfirm={() => {
              if (pendingSubmitMessage) flushSubmit(pendingSubmitMessage);
            }}
          />
        </ComposerStack>
      </div>
    </div>
  );
}

import * as React from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Archive, ArrowLeft, Bot, Loader2, RefreshCw, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { cn, isTauri } from "@/lib/utils";

import { SKILLS_CHANGED_EVENT } from "@/hooks/useAppInit";
import { useSessionStore } from "@/stores/session";
import { useStreamingStore } from "@/stores/streaming";
import { useVoiceInputStore } from "@/stores/voice-input";
import { useWorkspaceStore } from "@/stores/workspace";
import { useProviderStore, type ModelOption } from "@/stores/provider";
import { useTeamModeStore } from "@/stores/team-mode";
import { useSuggestionsStore } from "@/stores/suggestions";
import { useShortcutsStore } from "@/stores/shortcuts";
import { TEAMCLAW_DIR, CONFIG_FILE_NAME, TEAM_REPO_DIR } from "@/lib/build-config";
import { adaptTeamclawMessages } from "@/lib/v2-message-adapter";
import { useAuthStore } from "@/stores/auth-store";
import { useSessionListStore } from "@/stores/session-list-store";
import { useEngagedAgentStore } from "@/stores/engaged-agent-store";
import { useUIStore } from "@/stores/ui";
import { mqttPublish } from "@/lib/mqtt-bridge";
import { supabase } from "@/lib/supabase-client";
import { create as createMessage, toBinary } from "@bufbuild/protobuf";
import {
  MessageSchema,
  SessionMessageEnvelopeSchema,
  LiveEventEnvelopeSchema,
  MessageKind,
} from "@/lib/proto/teamclaw_pb";
import { resolveSessionActivityOwner } from "@/lib/session-list-activity";
import type { PromptInputMessage } from "@/packages/ai/prompt-input";
import type { AttachedAgent } from "@/packages/ai/prompt-input-insert-hooks";
type SendMessageFilePart = Record<string, unknown>;
import { Suggestions, Suggestion } from "@/packages/ai/suggestion";
import { Button } from "@/components/ui/button";

import type { Message } from "@/stores/session";
import { ChatInputArea } from "./ChatInputArea";
import { getFileName } from "./utils/fileUtils";
import { MessageList, type MessageListHandle } from "./MessageList";
import { SessionErrorAlert } from "./SessionErrorAlert";
import { PendingPermissionInline, hasVisiblePendingPermissions } from "./PermissionCard";
import { TodoList } from "./TodoList";
import { QuestionInputDock } from "./QuestionInputDock";
import { NewSessionActorPicker } from "./NewSessionActorPicker";
import { SessionContinueBanner } from "./SessionContinueBanner";
import { shouldOpenNewSessionActorPicker } from "./chat-panel-routing";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { StreamingAgentBubble } from "./StreamingAgentBubble";
import { TerminalPanel } from "@/components/terminal/TerminalPanel";
import { useTerminalStore } from "@/stores/terminal-store";

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function saveImageToWorkspace(
  file: File,
  workspacePath: string,
): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { mkdir, writeFile } = await import("@tauri-apps/plugin-fs");
    const uploadsDir = `${workspacePath}/.uploads`;
    try {
      await mkdir(uploadsDir, { recursive: true });
    } catch {
      // already exists
    }
    const ext = file.type.split("/")[1] || "png";
    const timestamp = Date.now();
    const filename = `paste-${timestamp}.${ext}`;
    const fullPath = `${uploadsDir}/${filename}`;
    const buffer = await file.arrayBuffer();
    await writeFile(fullPath, new Uint8Array(buffer));
    return fullPath;
  } catch (err) {
    console.error("[ChatPanel] Failed to save pasted image:", err);
    return null;
  }
}

const EMPTY_MESSAGES: Message[] = [];

function parseSlashToken(body: string): { type: "role" | "skill" | "command"; name: string } {
  if (body.startsWith("role:")) return { type: "role", name: body.slice("role:".length) };
  if (body.startsWith("skill:")) return { type: "skill", name: body.slice("skill:".length) };
  if (body.startsWith("command:")) return { type: "command", name: body.slice("command:".length) };
  return { type: "skill", name: body };
}

function buildEnhancedChip(
  type: "role" | "skill",
  name: string,
): string {
  const label = type === "role" ? "Role" : "Skill";
  const toolCall =
    type === "role"
      ? `role_load({ name: "${name}" })`
      : `skill({ name: "${name}" })`;
  return `[${label}: ${name}|instruction:You must call ${toolCall} before any other action.]`;
}

// ─── Main component ────────────────────────────────────────────────────────

interface ChatPanelProps {
  /** Compact mode for side panel in file mode layout */
  compact?: boolean;
}

export function ChatPanel({ compact = false }: ChatPanelProps) {
  const { t } = useTranslation();

  const customSuggestions = useSuggestionsStore(s => s.customSuggestions);
  const builtInSuggestions = [
    t("chat.suggestions.analyze", "Analyze data"),
    t("chat.suggestions.report", "Write a report"),
    t("chat.suggestions.skill", "Add a new skill"),
  ];
  const suggestions = [...builtInSuggestions, ...customSuggestions];

  // ── UI store selectors ───────────────────────────────────────────────
  const draftPreselectedActor = useUIStore(s => s.draftPreselectedActor);

  // ── Session store selectors (reactive state only) ────────────────────
  const activeSessionId = useSessionStore(s => s.activeSessionId);
  const error = useSessionStore(s => s.error);
  const errorSessionId = useSessionStore(s => s.errorSessionId);
  const isConnected = useSessionStore(s => s.isConnected);
  const streamingMessageId = useStreamingStore(s => s.streamingMessageId);
  const messageQueue = useSessionStore(s => s.messageQueue);
  const sessionError = useSessionStore(s => s.sessionError);
  const inactivityWarning = useSessionStore(s => s.inactivityWarning);
  const draftInput = useSessionStore(s => s.draftInput);
  const todos = useSessionStore(s => s.todos);
  const pendingPermissions = useSessionStore(s => s.pendingPermissions);
  const pendingQuestions = useSessionStore(s => s.pendingQuestions);
  const sessions = useSessionStore(s => s.sessions);

  // ── V2 agent streaming (acp.event deltas) ───────────────────────────
  // Only render ACTIVE bubbles. On finalize, the envelope handler appends
  // the completed reply to useSessionStore.messages — the regular
  // ChatMessage takes over chronological placement, and the bubble
  // disappears so multiple turns don't clobber prior replies.
  const v2StreamsByKey = useV2StreamingStore(s => s.byKey);
  const v2Streams = React.useMemo(
    () =>
      Object.values(v2StreamsByKey).filter(
        e => e.sessionId === activeSessionId && e.active,
      ),
    [v2StreamsByKey, activeSessionId],
  );

  // ── Archived session viewing ────────────────────────────────────────
  const viewingArchivedSessionId = useSessionStore(s => s.viewingArchivedSessionId);
  const archivedSessionMessages = useSessionStore(s =>
    s.viewingArchivedSessionId
      ? (s.archivedSessionMessages[s.viewingArchivedSessionId] || EMPTY_MESSAGES)
      : EMPTY_MESSAGES
  );
  const archivedSession = useSessionStore(s =>
    s.viewingArchivedSessionId
      ? s.archivedSessions.find((session) => session.id === s.viewingArchivedSessionId)
      : undefined
  );
  const archivedSessionError = useSessionStore(s => s.archivedSessionError);
  const isViewingArchived = !!viewingArchivedSessionId;

  // ── Child session viewing ──────────────────────────────────────────
  const viewingChildSessionId = useSessionStore(s => s.viewingChildSessionId);
  const childSessionMessages = useSessionStore(s =>
    s.viewingChildSessionId && !s.viewingArchivedSessionId
      ? (s.childSessionMessages[s.viewingChildSessionId] || EMPTY_MESSAGES)
      : EMPTY_MESSAGES
  );
  const isLoadingChildMessages = useSessionStore(s => s.isLoadingChildMessages);
  const childStreamingContent = useStreamingStore(s =>
    viewingChildSessionId && !isViewingArchived
      ? s.childSessionStreaming[viewingChildSessionId]
      : undefined
  );
  const isViewingChild = !!viewingChildSessionId && !isViewingArchived;
  const showInlineTodo = React.useMemo(() => {
    if (isViewingArchived) return false;
    if (isViewingChild) return false;
    if (todos.length === 0 && messageQueue.length === 0) return false;
    return !hasVisiblePendingPermissions(activeSessionId, sessions, pendingPermissions);
  }, [activeSessionId, isViewingArchived, isViewingChild, messageQueue.length, pendingPermissions, sessions, todos]);
  const displayedChildSessionMessages = React.useMemo(() => {
    if (!isViewingChild || !viewingChildSessionId) return EMPTY_MESSAGES;

    const hasLiveChildStreaming =
      !!childStreamingContent &&
      (childStreamingContent.isStreaming ||
        !!childStreamingContent.text ||
        !!childStreamingContent.reasoning);

    if (!hasLiveChildStreaming) {
      return childSessionMessages;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hasStreamingPlaceholder = childSessionMessages.some((message: any) => message.isStreaming);
    if (hasStreamingPlaceholder) {
      return childSessionMessages;
    }

    const lastTimestamp = childSessionMessages[childSessionMessages.length - 1]?.timestamp;
    const placeholderTimestamp =
      lastTimestamp instanceof Date
        ? new Date(lastTimestamp.getTime() + 1)
        : new Date();

    return [
      ...childSessionMessages,
      {
        id: `child-streaming-${viewingChildSessionId}`,
        sessionId: viewingChildSessionId,
        role: "assistant" as const,
        content: childStreamingContent?.text || "",
        parts: [],
        toolCalls: [],
        isStreaming: true,
        timestamp: placeholderTimestamp,
      },
    ];
  }, [childSessionMessages, childStreamingContent, isViewingChild, viewingChildSessionId]);
  const activeInputQuestion = React.useMemo(() => {
    if (!activeSessionId) return null;
    if (isViewingArchived) return null;
    if (isViewingChild) return null;
    return (
      pendingQuestions.find((question) => {
        if (!question.sessionId) return true;
        return (
          resolveSessionActivityOwner(question.sessionId, sessions, question.sessionId) ===
          activeSessionId
        );
      }) ||
      null
    );
  }, [activeSessionId, isViewingArchived, isViewingChild, pendingQuestions, sessions]);

  // Actions — accessed via getState() to avoid creating subscriptions.
  // Zustand actions are stable references; subscribing to them wastes equality checks.
  const acts = useSessionStore.getState();
  const sendMessage = acts.sendMessage;
  const abortSession = acts.abortSession;
  const removeFromQueue = acts.removeFromQueue;
  const loadSessions = acts.loadSessions;
  const resetSessions = acts.resetSessions;
  const clearSessionError = acts.clearSessionError;
  const setError = acts.setError;
  const setStoreSelectedModel = acts.setSelectedModel;
  const setDraftInput = acts.setDraftInput;
  const closeArchivedSession = acts.closeArchivedSession;
  const restoreSession = acts.restoreSession;
  const setViewingChildSession = acts.setViewingChildSession;

  // ── Workspace store ───────────────────────────────────────────────────
  const workspacePath = useWorkspaceStore(s => s.workspacePath);
  // Keep local semaphores that simply mirror "workspace is set"; the legacy
  // separate bootstrapped vs ready flags collapsed into one signal.
  const workspaceBootstrapped = !!workspacePath;
  const workspaceReady = !!workspacePath;
  const currentWorkspaceId = workspacePath ?? "";
  const terminalOpen = useTerminalStore(
    s => Boolean(currentWorkspaceId && s.panelOpenByWorkspace[currentWorkspaceId]),
  );
  const terminalPanelHeight = useTerminalStore(
    s => currentWorkspaceId ? s.panelHeightByWorkspace[currentWorkspaceId] ?? 240 : 240,
  );
  const terminalBottomOffset = terminalOpen && workspacePath ? terminalPanelHeight : 0;
  const setWorkspaceBootstrapped = React.useCallback((_v: boolean) => {}, []);

  // ── Local state ───────────────────────────────────────────────────────
  const inputValue = draftInput;
  const setInputValue = setDraftInput;
  const [attachedFiles, setAttachedFiles] = React.useState<string[]>([]);
  // engagedAgent is per-session: stored in a zustand slice keyed by
  // sessionId, so switching away from a session and back restores its
  // engaged agent rather than carrying one across sessions globally.
  // For brand-new chats (activeSessionId === null), engagedAgent is null.
  const engagedAgent = useEngagedAgentStore((s) =>
    activeSessionId ? s.bySession[activeSessionId] ?? null : null,
  );
  const setEngagedAgentForSession = React.useCallback(
    (agent: AttachedAgent | null) => {
      const sid = useSessionStore.getState().activeSessionId;
      if (!sid) return;
      useEngagedAgentStore.getState().setEngagedAgent(sid, agent);
    },
    [],
  );
  // Dedupe runtimeStart RPCs across re-engages within the same session.
  const ensuredRuntimesRef = React.useRef<Set<string>>(new Set());
  const [pendingFirstMessage, setPendingFirstMessage] = React.useState<PromptInputMessage | null>(null);
  const sessionRow = useSessionListStore(s => s.rows.find(r => r.id === activeSessionId));
  // Team is workspace-scoped: every session in `rows` shares the same team_id.
  // When activeSessionId is null (brand-new chat), fall back to any row's
  // team_id so SessionActorSheet still has a team context for the add flow.
  const fallbackTeamId = useSessionListStore(s => s.rows[0]?.team_id ?? null);
  const sheetTeamId = sessionRow?.team_id ?? fallbackTeamId;
  const [imageFiles, setImageFiles] = React.useState<File[]>([]);
  const [hasSkillRestartPrompt, setHasSkillRestartPrompt] = React.useState(false);
  const [isRestartingSkillsRuntime, setIsRestartingSkillsRuntime] = React.useState(false);
  const [isRestoringArchived, setIsRestoringArchived] = React.useState(false);
  const isRestoringArchivedRef = React.useRef(false);

  const isImagePath = React.useCallback((path: string) => {
    return /\.(png|jpe?g|gif|webp|svg|bmp|ico|heic|heif)$/i.test(path);
  }, []);

  const extractImageAttachmentTokens = React.useCallback(
    (text: string): { cleaned: string; imagePaths: string[] } => {
      // Support tolerant attachment token parsing from pasted text.
      // Examples:
      // [Attachment: a.png] (path: /x/a.png)
      // [Attachment:a.png](path:/x/a.png)
      const attachmentPattern = /\[Attachment:\s*([^\]]+)\]\s*\(([^)]*)\)/gi;
      const imagePaths: string[] = [];

      let cleaned = text.replace(attachmentPattern, (full, _name, info) => {
        const pathMatch = String(info).match(/path:\s*([^,)]+)/i);
        const fullPath = pathMatch ? pathMatch[1].trim() : "";
        if (fullPath && isImagePath(fullPath)) {
          imagePaths.push(fullPath);
          return "";
        }
        return full;
      });

      // Extra defensive pass: line-wise removal for any remaining textual
      // attachment tokens that point to image paths.
      const filteredLines = cleaned.split("\n").filter((line) => {
        if (!line.includes("[Attachment:")) return true;
        const pathMatch = line.match(/path:\s*([^)]+)\)?/i);
        const maybePath = pathMatch ? pathMatch[1].trim() : "";
        if (maybePath && isImagePath(maybePath)) return false;
        return true;
      });

      cleaned = filteredLines.join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/ {2,}/g, " ")
        .trimStart();

      return { cleaned, imagePaths };
    },
    [isImagePath],
  );

  // ── Provider store ────────────────────────────────────────────────────
  const currentModelKey = useProviderStore(s => s.currentModelKey);
  const initProviderStore = useProviderStore(s => s.initAll);
  // Derive selected model from currentModelKey + models. Use useMemo with a
  // ref to avoid returning a new object when the logical value hasn't changed.
  // This prevents re-render cascades when initAll() rebuilds the models array
  // with identical data (fixes TEAMCLAW-REACT-1R).
  const providerModels = useProviderStore(s => s.models);
  const selectedModelOptionRef = React.useRef<ModelOption | null>(null);
  const selectedModelOption = React.useMemo(() => {
    if (!currentModelKey) {
      selectedModelOptionRef.current = null;
      return null;
    }
    const idx = currentModelKey.indexOf('/');
    if (idx < 0) {
      selectedModelOptionRef.current = null;
      return null;
    }
    const providerId = currentModelKey.substring(0, idx);
    const modelId = currentModelKey.substring(idx + 1);
    const found = providerModels.find((m) => m.provider === providerId && m.id === modelId) || null;
    const prev = selectedModelOptionRef.current;
    if (prev && found && prev.id === found.id && prev.provider === found.provider && prev.name === found.name) {
      return prev; // stable reference
    }
    selectedModelOptionRef.current = found;
    return found;
  }, [currentModelKey, providerModels]);

  // ── Refs ───────────────────────────────────────────────────────────────
  const messageListRef = React.useRef<MessageListHandle>(null);

  // ── Derived values ────────────────────────────────────────────────────
  // v2: messages live in useSessionStore.messages keyed by sessionId.
  // Adapt each Teamclaw_Message → SDK Message shape so legacy MessageList
  // renders unchanged. Phase 2 will replace MessageList with native render.
  const activeMessagesRaw = useSessionStore(s =>
    s.activeSessionId ? s.messages?.[s.activeSessionId] : undefined
  );
  const activeMessages = React.useMemo(
    () => adaptTeamclawMessages(activeMessagesRaw),
    [activeMessagesRaw],
  );
  /** Shown messages lag store during fade so old session can fade out before swap */
  const [displaySessionId, setDisplaySessionId] = React.useState<string | null>(activeSessionId);
  const [sessionFadeOpacity, setSessionFadeOpacity] = React.useState(1);

  const displayMessagesRaw = useSessionStore((s) =>
    displaySessionId ? s.messages?.[displaySessionId] : undefined,
  );
  const displayMessages = React.useMemo(
    () => adaptTeamclawMessages(displayMessagesRaw),
    [displayMessagesRaw],
  );

  const SESSION_FADE_MS = 150;

  React.useEffect(() => {
    if (activeSessionId === null) {
      setDisplaySessionId(null);
      setSessionFadeOpacity(1);
      // engagedAgent is per-session now; no need to clear here — the
      // selector returns null for null sessionId automatically.
    }
    // Switching session invalidates the runtime-ensured memo — different
    // (session, agent) pairs should each get their own runtimeStart.
    ensuredRuntimesRef.current = new Set();
  }, [activeSessionId]);

  React.useEffect(() => {
    if (activeSessionId === null) return;
    if (displaySessionId === activeSessionId) return;
    if (displaySessionId === null) {
      setDisplaySessionId(activeSessionId);
      setSessionFadeOpacity(1);
      return;
    }
    setSessionFadeOpacity(0);
    const t = window.setTimeout(() => {
      setDisplaySessionId(activeSessionId);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setSessionFadeOpacity(1));
      });
    }, SESSION_FADE_MS);
    return () => clearTimeout(t);
  }, [activeSessionId, displaySessionId]);

  const isStreaming = !!streamingMessageId;

  // ── Provider & Team mode init ──────────────────────────────────────
  // Merged to avoid race condition: team mode restarts the agent, which
  // would break a concurrent initProviderStore call.
  React.useEffect(() => {
    if (!workspaceReady) return;

    if (!workspacePath) {
      // No workspace yet, just init providers directly
      initProviderStore();
      return;
    }

    const { loadTeamConfig, applyTeamModel } = useTeamModeStore.getState();
    loadTeamConfig(workspacePath).then(async () => {
      if (useTeamModeStore.getState().teamMode) {
        // Team mode: apply team config (restarts the agent), then init providers.
        // applyTeamModel is idempotent — skips if config key unchanged.
        await applyTeamModel(workspacePath);
      }
      initProviderStore();
    });
  }, [workspaceReady, workspacePath]);

  // ── Team config hot reload via file watcher ─────────────────────────
  React.useEffect(() => {
    if (!workspaceBootstrapped || !workspacePath) return;
    const isTauriEnv = isTauri();
    if (!isTauriEnv) return;

    let unlisten: (() => void) | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<{ path: string; kind: string }>('file-change', (event) => {
        const isTeamConfigChange = event.payload.path.includes(`${TEAMCLAW_DIR}/${CONFIG_FILE_NAME}`);
        const isProviderMetaChange = event.payload.path.includes(`${TEAM_REPO_DIR}/_meta/provider.json`);
        if (!isTeamConfigChange && !isProviderMetaChange) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          console.log('[TeamMode] Team config changed, reloading team config');
          const store = useTeamModeStore.getState();
          const wasTeamMode = store.teamMode;
          await store.loadTeamConfig(workspacePath);
          const isTeamMode = useTeamModeStore.getState().teamMode;
          
          if (isTeamMode) {
            await store.applyTeamModel(workspacePath);
          } else if (wasTeamMode && !isTeamMode) {
            // Ensure provider store is refreshed if team mode was cleared
            await useProviderStore.getState().initAll();
            // Force a re-render by triggering a state update
            useTeamModeStore.setState({ teamMode: false, teamModelConfig: null });
          }
        }, 1000);
      });
    })();

    return () => {
      if (unlisten) unlisten();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [workspaceReady, workspacePath]);

  React.useEffect(() => {
    const onSkillsChanged = () => setHasSkillRestartPrompt(true);
    window.addEventListener(SKILLS_CHANGED_EVENT, onSkillsChanged);
    return () => window.removeEventListener(SKILLS_CHANGED_EVENT, onSkillsChanged);
  }, []);

  // ── Team shortcuts hot reload via file watcher ─────────────────────────
  React.useEffect(() => {
    if (!workspaceBootstrapped || !workspacePath) return;
    const isTauriEnv = isTauri();
    if (!isTauriEnv) return;

    let unlisten: (() => void) | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<{ path: string; kind: string }>('file-change', (event) => {
        if (!event.payload.path.includes(`${TEAM_REPO_DIR}/_meta/shortcuts.json`)) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          console.log('[TeamShortcuts] _meta/shortcuts.json changed, reloading');
          const { loadTeamShortcutsFile } = await import('@/lib/team-shortcuts');
          const nodes = await loadTeamShortcutsFile(workspacePath);
          useShortcutsStore.getState().setTeamNodes(nodes || []);
        }, 500);
      });
    })();

    return () => {
      if (unlisten) unlisten();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [workspaceReady, workspacePath]);

  // Sync selected model to session store
  React.useEffect(() => {
    if (selectedModelOption) {
      setStoreSelectedModel({
        providerID: selectedModelOption.provider,
        modelID: selectedModelOption.id,
        name: selectedModelOption.name,
      });
    }
  }, [currentModelKey, selectedModelOption]);

  React.useEffect(() => {
    if (!isTauri() || !activeSessionId) return;

    const modelKey = selectedModelOption
      ? `${selectedModelOption.provider}/${selectedModelOption.id}`
      : null;

    invoke<boolean>("sync_gateway_session_model", {
      sessionId: activeSessionId,
      model: modelKey,
    }).catch((error) => {
      console.warn("[ChatPanel] Failed to sync gateway session model:", error);
    });
  }, [activeSessionId, selectedModelOption]);

  // ── Per-actor draft persistence ──────────────────────────────────────
  // When the user taps an actor in the Actors tab without sending anything
  // and then navigates away (different actor, settings, etc.), their
  // typed-but-unsent text persists in localStorage keyed by actor id and
  // is restored next time they preselect the same actor.
  const draftStorageKey = draftPreselectedActor
    ? `teamclaw-actor-draft:${draftPreselectedActor.id}`
    : null;
  const justRestoredDraftRef = React.useRef(false);

  // Restore saved draft when actor changes.
  React.useEffect(() => {
    if (!draftStorageKey) return;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(draftStorageKey);
    } catch {
      /* localStorage disabled */
    }
    if (saved != null && saved !== inputValue) {
      justRestoredDraftRef.current = true;
      setInputValue(saved);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftStorageKey]);

  // Debounced persist on input change. Skips the tick immediately after a
  // restore so we don't overwrite what we just read.
  React.useEffect(() => {
    if (!draftStorageKey) return;
    if (justRestoredDraftRef.current) {
      justRestoredDraftRef.current = false;
      return;
    }
    const handle = setTimeout(() => {
      try {
        if (inputValue) {
          localStorage.setItem(draftStorageKey, inputValue);
        } else {
          localStorage.removeItem(draftStorageKey);
        }
      } catch {
        /* localStorage disabled */
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [draftStorageKey, inputValue]);

  // Voice input / "Add to Agent": append transcript or file mention to input
  React.useEffect(() => {
    const unregister = useVoiceInputStore.getState().registerInsertToChatHandler(
      (transcript) => {
        const prev = useSessionStore.getState().draftInput;
        // Deduplicate @{filepath} mentions — prevent double insertion
        const mentionMatch = transcript.match(/@\{([^}]+)\}/);
        if (mentionMatch && prev.includes(mentionMatch[0])) return;
        setInputValue(prev + (prev ? " " : "") + transcript);
      },
    );
    return unregister;
  }, []);

  // ── Auto-dismiss error banners after 5 seconds ─────────────────────────
  React.useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(timer);
  }, [error, setError]);

  React.useEffect(() => {
    if (!sessionError) return;
    // Retry errors are cleared by handleSessionStatus when session transitions
    // to busy or idle — don't auto-dismiss them.
    const isRetryError = sessionError.error?.name === 'RetryError';
    if (isRetryError) return;
    const timer = setTimeout(() => clearSessionError(), 15000);
    return () => clearTimeout(timer);
  }, [sessionError, clearSessionError]);

  // SSE connection is managed by SSEProvider in App.tsx (persists across mode switches)

  // Poll for pending permissions as fallback
  const pollPermissions = useSessionStore((s) => s.pollPermissions);
  const hasRunningTools = React.useMemo(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (activeMessages ?? []).some((m: any) => m.toolCalls?.some((tc: any) => tc.status === "calling" || tc.status === "waiting")),
    [activeMessages],
  );
  React.useEffect(() => {
    if (!activeSessionId) return;
    if (!isStreaming && !hasRunningTools) return;
    const interval = setInterval(pollPermissions, 2000);
    return () => clearInterval(interval);
  }, [isStreaming, hasRunningTools, activeSessionId, pollPermissions]);


  // ── Session loading ───────────────────────────────────────────────────
  const prevWorkspaceRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!workspaceBootstrapped || !workspacePath) return;

    const isWorkspaceChange =
      prevWorkspaceRef.current !== null &&
      prevWorkspaceRef.current !== workspacePath;
    prevWorkspaceRef.current = workspacePath;

      if (isWorkspaceChange) {
      resetSessions();
      }

    console.log("[ChatPanel] Workspace bootstrapped, loading sessions for:", workspacePath);
        loadSessions(workspacePath)
      .then(() => setError(null))
      .catch((err: unknown) =>
        console.error("[ChatPanel] Failed to load sessions:", err),
      );
  }, [workspaceBootstrapped, workspacePath, loadSessions, resetSessions]);

  // NOTE: No polling fallback needed.
  // SSE /event endpoint streams ALL events (Bus.subscribeAll) including
  // session.created and session.updated, which are handled as global events
  // in the SSE client. The SSE connection is established as soon as baseUrl
  // is available, regardless of whether a session is active.

  // ── Input height change → forward to MessageList ───────────────────────
  const handleInputHeightChange = React.useCallback((height: number) => {
    messageListRef.current?.handleInputHeightChange(height);
  }, []);

  // ── File handling ─────────────────────────────────────────────────────

  const handleFilesChange = (paths: string[]) => {
    setAttachedFiles((prev) => [...prev, ...paths]);
  };

  const handleInputChange = React.useCallback(
    (nextValue: string) => {
      const { cleaned, imagePaths } = extractImageAttachmentTokens(nextValue);
      if (imagePaths.length > 0) {
        setAttachedFiles((prev) => {
          const seen = new Set(prev);
          const uniqueNew = imagePaths.filter((p) => !seen.has(p));
          return uniqueNew.length > 0 ? [...prev, ...uniqueNew] : prev;
        });
      }
      setInputValue(cleaned);
    },
    [extractImageAttachmentTokens, setInputValue],
  );

  // Fallback sanitizer: if input text is injected through another path,
  // still normalize it and convert image attachment tokens into previews.
  React.useEffect(() => {
    if (!inputValue) return;
    const { cleaned, imagePaths } = extractImageAttachmentTokens(inputValue);

    if (imagePaths.length > 0) {
      setAttachedFiles((prev) => {
        const seen = new Set(prev);
        const uniqueNew = imagePaths.filter((p) => !seen.has(p));
        return uniqueNew.length > 0 ? [...prev, ...uniqueNew] : prev;
      });
    }

    if (cleaned !== inputValue) {
      setInputValue(cleaned);
    }
  }, [inputValue, extractImageAttachmentTokens, setInputValue]);

  const removeFile = (index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleImageFilesChange = (files: File[]) => {
    setImageFiles((prev) => [...prev, ...files]);
  };

  const removeImageFile = (index: number) => {
    setImageFiles((prev) => prev.filter((_, i) => i !== index));
  };

  // ── Submit handler ────────────────────────────────────────────────────

  /**
   * Core send logic — takes an EXPLICIT sid so it can be called both from
   * the normal handleSubmit path (activeSessionId) and from the picker-confirm
   * path (freshly-created sessionId).  Must NOT close over activeSessionId.
   */
  const sendIntoSession = async (
    sid: string,
    message: PromptInputMessage,
    extraMentionAgents: AttachedAgent[] = [],
  ) => {
    // v2: workspace-ready gate removed — the legacy sidecar flag is gone.
    // Single-window scope sends via MQTT + Supabase regardless.
    const text = message.text?.trim() || "";
    const mentions = message.mentions || [];
    // Combine engaged agent + picker-supplied agents, dedup by id.
    const allAgents: AttachedAgent[] = engagedAgent ? [engagedAgent] : [];
    for (const ea of extraMentionAgents) {
      if (!allAgents.some((a) => a.id === ea.id)) allAgents.push(ea);
    }
    const memberIds = mentions.map((m) => m.id);
    const agentIds = allAgents.map((a) => a.id);
    const mentionActorIds = Array.from(new Set([...memberIds, ...agentIds]));
    const _isPlanMode = !!(message as PromptInputMessage & { _planMode?: boolean })._planMode;

    if (!text && attachedFiles.length === 0 && mentions.length === 0 && imageFiles.length === 0) return;

    let finalContent: string;
    const personMentions: string[] = [];

    if (mentions.length > 0) {
      for (const mention of mentions) {
        const mentionText = mention.email
          ? `${mention.name} (${mention.email})`
          : mention.name;
        personMentions.push(mentionText);
      }
    }

    // Build final content preserving the order
    let processedText = text;

    // Replace @{filepath} with [File: filepath] inline
    processedText = processedText.replace(/@\{([^}]+)\}/g, '[File: $1]');

    // Replace unified /{type:name} inline, while keeping legacy formats readable.
    processedText = processedText.replace(/\/\{([^}]+)\}/g, (_full, body) => {
      const token = parseSlashToken(body);
      if (token.type === "role") return buildEnhancedChip("role", token.name);
      if (token.type === "command") return `[Command: ${token.name}]`;
      return buildEnhancedChip("skill", token.name);
    });
    processedText = processedText.replace(/\/<([a-z0-9]+(?:-[a-z0-9]+)*)>/g, (_full, roleName) =>
      buildEnhancedChip("role", roleName),
    );
    processedText = processedText.replace(/\/\[([^\]]+)\]/g, '[Command: $1]');

    const parts: string[] = [];

    // Prepend literal @AgentName tokens so the rendered user message
    // visibly carries the mention (matches @-member rendering and makes
    // history readable). Picker auto-mentions land here too via
    // extraMentionAgents.
    const agentMentionPrefix = allAgents.length > 0
      ? allAgents.map((a) => `@${a.displayName}`).join(" ")
      : "";

    // Add person mentions at the beginning
    if (personMentions.length > 0) {
      parts.push(`[Mentioned: ${personMentions.join(', ')}]`);
    }

    // Add attached files at the beginning
    if (attachedFiles.length > 0) {
      for (const filePath of attachedFiles) {
        parts.push(`[Attachment: ${getFileName(filePath)}] (path: ${filePath})`);
      }
    }

    // Add the processed text (with inline [File: ...] replacements),
    // prefixed by agent @-mentions if any.
    const bodyText = agentMentionPrefix
      ? (processedText.trim()
        ? `${agentMentionPrefix} ${processedText.trim()}`
        : agentMentionPrefix)
      : processedText.trim();
    if (bodyText) {
      parts.push(bodyText);
    }

    finalContent = parts.join("\n\n");

    // Save pasted images to workspace and build file parts
    let _imageParts: SendMessageFilePart[] | undefined;
    if (imageFiles.length > 0) {
      const savedPaths: string[] = [];
      _imageParts = await Promise.all(
        imageFiles.map(async (file) => {
          const dataUrl = await fileToDataUrl(file);
          // Save to workspace so agent tools can access the file
          if (workspacePath) {
            const savedPath = await saveImageToWorkspace(file, workspacePath);
            if (savedPath) {
              savedPaths.push(savedPath);
            }
          }
          return {
            type: 'file' as const,
            url: dataUrl,
            mime: file.type,
            filename: file.name,
          };
        }),
      );
      // Include saved file paths in text so the agent knows where to find them
      if (savedPaths.length > 0) {
        for (const p of savedPaths) {
          const name = p.split("/").pop() || "image";
          parts.push(`[Attachment: ${name}] (path: ${p})`);
        }
        finalContent = parts.join("\n\n");
      }
    }

    // v2 send: build LiveEventEnvelope, publish via MQTT, persist to
    // Supabase, and locally append for immediate render. Drops imageParts
    // and isPlanMode for now — single-window scope; Phase 2 wires those.
    const outgoing = finalContent;
    if (outgoing && outgoing.trim()) {
      const authSession = useAuthStore.getState().session;
      // Resolve the session's team_id. Prefer the cached row (fast path);
      // if the session was just created and isn't in `rows` yet (or got
      // pushed off the top-50 slice), query supabase directly so we
      // don't silently drop the send.
      let teamIdForSend: string | null =
        useSessionListStore.getState().rows.find(r => r.id === sid)?.team_id ?? null;
      if (!teamIdForSend && sid) {
        const { data: sessionRow } = await supabase
          .from("sessions")
          .select("team_id")
          .eq("id", sid)
          .maybeSingle();
        teamIdForSend = (sessionRow as { team_id?: string } | null)?.team_id ?? null;
      }
      if (sid && authSession && teamIdForSend) {
        try {
          const { data: actorRows, error: actorErr } = await supabase
            .from("actors")
            .select("id, team_id")
            .eq("user_id", authSession.user.id);
          if (actorErr) throw actorErr;
          const matching = (actorRows ?? []).find((a) => a.team_id === teamIdForSend);
          if (!matching) throw new Error(`No actor found for user in team ${teamIdForSend}`);
          const senderActorId = matching.id as string;
          const messageId = crypto.randomUUID();
          const createdAt = BigInt(Math.floor(Date.now() / 1000));

          const msg = createMessage(MessageSchema, {
            messageId,
            sessionId: sid,
            senderActorId,
            kind: MessageKind.TEXT,
            content: outgoing,
            createdAt,
          });
          const sessionMsg = createMessage(SessionMessageEnvelopeSchema, {
            message: msg,
            mentionActorIds,
          });
          const live = createMessage(LiveEventEnvelopeSchema, {
            eventId: crypto.randomUUID(),
            eventType: "message.created",
            sessionId: sid,
            actorId: senderActorId,
            sentAt: createdAt,
            body: toBinary(SessionMessageEnvelopeSchema, sessionMsg),
          });
          await mqttPublish(
            `amux/${teamIdForSend}/session/${sid}/live`,
            toBinary(LiveEventEnvelopeSchema, live),
            false,
          );
          const { error: insErr } = await supabase.from("messages").insert({
            id: messageId,
            team_id: teamIdForSend,
            session_id: sid,
            sender_actor_id: senderActorId,
            kind: "text",
            content: outgoing,
            metadata: { mention_actor_ids: mentionActorIds },
          });
          if (insErr) throw insErr;
          useSessionStore.getState().appendMessage(sid, msg);
        } catch (e) {
          console.error("[ChatPanel] send failed:", e);
        }
      }
    }

    setInputValue("");
    setAttachedFiles([]);
    setImageFiles([]);
  };

  const handleSubmit = async (message: PromptInputMessage) => {
    if (!activeSessionId) {
      // No session yet. Two paths:
      //   1. Actor-draft mode (user tapped an actor row → draftPreselectedActor
      //      is set): skip the picker, create the session with that one actor
      //      and send straight away.
      //   2. Otherwise: open the picker; the picker's confirm calls back into
      //      the same creation routine via handlePickerConfirm.
      if (draftPreselectedActor) {
        const picks =
          draftPreselectedActor.kind === 'agent'
            ? {
                agents: [{ id: draftPreselectedActor.id, displayName: draftPreselectedActor.displayName }],
                members: [],
              }
            : {
                agents: [],
                members: [{ id: draftPreselectedActor.id, displayName: draftPreselectedActor.displayName }],
              };
        try {
          localStorage.removeItem(`teamclaw-actor-draft:${draftPreselectedActor.id}`);
        } catch {
          /* localStorage disabled */
        }
        useUIStore.getState().clearActorDraft();
        await createSessionAndSendFirst(message, picks);
        return;
      }
      setPendingFirstMessage(message);
      return;
    }
    if (shouldOpenNewSessionActorPicker({
      activeSessionId,
      activeMessageCount: activeMessages?.length ?? 0,
      hasDraftPreselectedActor: !!draftPreselectedActor,
    })) {
      setPendingFirstMessage(message);
      return;
    }
    await sendIntoSession(activeSessionId, message);
  };

  // ── New-session creation: shared by the picker confirm path and the
  //    actor-draft (preselected actor) path ───────────────────────────────
  const createSessionAndSendFirst = async (
    firstMessage: PromptInputMessage,
    picks: {
      members: { id: string; displayName: string }[]
      agents: { id: string; displayName: string }[]
    },
  ) => {
    const teamIdForSend = sheetTeamId;
    if (!teamIdForSend) {
      console.error('[ChatPanel] no team_id available; cannot create session');
      return;
    }

    const authSession = useAuthStore.getState().session;
    if (!authSession?.user?.id) {
      console.error('[ChatPanel] no auth session');
      return;
    }
    const { data: actorRows } = await supabase
      .from('actors')
      .select('id, team_id')
      .eq('user_id', authSession.user.id);
    const myActor = (actorRows ?? []).find((a: { id: string; team_id: string }) => a.team_id === teamIdForSend);
    if (!myActor) {
      console.error('[ChatPanel] no actor record for user in team', teamIdForSend);
      return;
    }

    // Initial title: "ActorName (HH:mm)" when we have exactly one
    // preselected actor (so multiple sessions to the same actor stay
    // distinguishable in the list until agent auto-rename kicks in).
    // Otherwise fall back to the message text or a generic placeholder.
    const soloActor =
      picks.members.length + picks.agents.length === 1
        ? picks.members[0] ?? picks.agents[0]
        : null;
    const pad = (n: number) => n.toString().padStart(2, '0');
    const now = new Date();
    const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const titleSource = soloActor
      ? `${soloActor.displayName} (${hhmm})`
      : (firstMessage.text ?? '').trim() || 'New chat';

    try {
      const { createSessionShell, startAgentRuntimesAsync } = await import('@/lib/session-create');
      const memberIds = picks.members.map((m) => m.id);
      const agentIds = picks.agents.map((a) => a.id);
      const allAdditional = Array.from(new Set([...memberIds, ...agentIds]));
      const draftIdeaId = useUIStore.getState().draftIdeaId;
      const { sessionId } = await createSessionShell({
        teamId: teamIdForSend,
        creatorActorId: myActor.id,
        title: titleSource,
        additionalActorIds: allAdditional,
        ideaId: draftIdeaId,
      });
      if (draftIdeaId) {
        useUIStore.getState().clearDraftIdeaId();
      }

      // Subscribe to the new session's live topic before publishing the
      // first message — otherwise the daemon's acp.event + message.created
      // can arrive before the reactive per-rows subscribe catches up.
      const { ensureSessionLiveSubscribed } = await import('@/App');
      await ensureSessionLiveSubscribed(teamIdForSend, sessionId);

      // Refresh session-list-store so the new row appears in the sidebar
      // and sendIntoSession can find it by id.
      await useSessionListStore.getState().load();
      useSessionStore.getState().addHighlightedSession(sessionId);
      await useUIStore.getState().switchToSession(sessionId);

      // Auto-engage + auto-mention ONLY when there's exactly one agent
      // (no members). Anything more ambiguous leaves the dock empty and
      // routes to the user.
      const soleAgent =
        picks.members.length === 0 && picks.agents.length === 1
          ? picks.agents[0]
          : null;
      if (soleAgent) {
        useEngagedAgentStore.getState().setEngagedAgent(sessionId, soleAgent);
      }
      const autoMentionAgents: AttachedAgent[] = soleAgent ? [soleAgent] : [];
      await sendIntoSession(sessionId, firstMessage, autoMentionAgents);

      // Fire-and-forget runtime spawn — UI has already moved into the
      // session; status dots update via RuntimeInfo subscriptions.
      if (picks.agents.length > 0) {
        // Mark these (session, agent) pairs as already-ensured so the
        // user's next @-mention via the input doesn't re-fire runtimeStart
        // (which would make the daemon create a second runtime for the
        // same pair → duplicate replies).
        for (const aid of agentIds) {
          ensuredRuntimesRef.current.add(`${sessionId}:${aid}`);
        }
        void startAgentRuntimesAsync({
          sessionId,
          teamId: teamIdForSend,
          agentActorIds: agentIds,
        });
      }
    } catch (e) {
      console.error('[ChatPanel] session creation failed:', e);
      const { toast } = await import('sonner');
      toast.error(t('chat.newSessionPicker.createError', 'Failed to create session'));
    }
  };

  // ── New-session picker handlers ────────────────────────────────────────

  const handlePickerConfirm = async (
    picks: {
      members: { id: string; displayName: string }[]
      agents: { id: string; displayName: string }[]
    },
  ) => {
    if (!pendingFirstMessage) return;
    const message = pendingFirstMessage;
    setPendingFirstMessage(null);
    await createSessionAndSendFirst(message, picks);
  };

  const handlePickerCancel = () => {
    setPendingFirstMessage(null);
  };

  const handleSuggestionClick = React.useCallback(
    (suggestion: string) => {
      // Keep all quick suggestions visually consistent with slash skill selection.
      setInputValue(`/{${suggestion}} `);
    },
    [setInputValue],
  );

  const handleRestartSkillsRuntime = React.useCallback(async () => {
    // Agent restart is handled by the amuxd daemon now; no-op for the legacy path.
    setIsRestartingSkillsRuntime(false);
    setHasSkillRestartPrompt(false);
  }, []);

  const handleCloseArchivedSession = React.useCallback(() => {
    closeArchivedSession();
    setViewingChildSession?.(null);
  }, [closeArchivedSession, setViewingChildSession]);

  const handleRestoreArchivedSession = React.useCallback(async () => {
    if (!viewingArchivedSessionId || isRestoringArchivedRef.current) return;
    isRestoringArchivedRef.current = true;
    setIsRestoringArchived(true);
    try {
      await restoreSession(viewingArchivedSessionId);
    } finally {
      isRestoringArchivedRef.current = false;
      setIsRestoringArchived(false);
    }
  }, [restoreSession, viewingArchivedSessionId]);

  // ── Empty state with suggestions ──────────────────────────────────────
  // Two variants:
  //   1. Actor-draft: user tapped an actor row, so the implicit recipient
  //      is known. Show the actor's name as the heading and skip the
  //      generic suggestions.
  //   2. Generic: show "Start a New Chat" + suggestions; first message
  //      triggers NewSessionActorPicker.
  const emptyState = React.useMemo(() => {
    if (draftPreselectedActor) {
      return (
        <div
          className={cn(
            "flex flex-col items-center justify-center text-center",
            compact ? "py-8 px-2" : "py-20",
          )}
        >
          <h2
            className={cn(
              "mb-1 font-semibold",
              compact ? "text-sm" : "text-xl",
            )}
          >
            {draftPreselectedActor.displayName}
          </h2>
          <p
            className={cn(
              "text-muted-foreground",
              compact ? "text-xs" : "text-sm",
            )}
          >
            {draftPreselectedActor.kind === 'agent'
              ? t('chat.draftWithAgentHint', 'Send a message to start a session with this agent')
              : t('chat.draftWithMemberHint', 'Send a message to start a session with this member')}
          </p>
          <SessionContinueBanner
            actorId={draftPreselectedActor.id}
            actorName={draftPreselectedActor.displayName}
          />
        </div>
      );
    }
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center text-center",
          compact ? "py-8 px-2" : "py-20",
        )}
      >
        <h2
          className={cn(
            "mb-1 font-semibold",
            compact ? "text-sm" : "text-xl",
          )}
        >
          {compact ? t("chat.agent", "Agent") : t("chat.startNewChat", "Start a New Chat")}
        </h2>
        <p
          className={cn(
            "text-muted-foreground",
            compact ? "text-xs mb-2" : "text-sm mb-6",
          )}
        >
          {compact
            ? t("chat.askAboutFile", "Ask questions about the file")
            : t("chat.askAnything", "Ask me anything, or choose a suggestion below")}
        </p>
        {!compact && (
          <Suggestions>
            {suggestions.map((suggestion) => (
              <Suggestion
                key={suggestion}
                suggestion={suggestion}
                onClick={() => handleSuggestionClick(suggestion)}
              />
            ))}
          </Suggestions>
        )}
      </div>
    );
  }, [compact, t, suggestions, handleSuggestionClick, draftPreselectedActor]);

  const visibleSessionError =
    sessionError?.sessionId && sessionError.sessionId === displaySessionId
      ? sessionError
      : null;
  const visibleError =
    error && errorSessionId && errorSessionId === displaySessionId
      ? error
      : null;

  const messageBottomContent = !isViewingChild ? (
    <>
      {v2Streams.map(entry => (
        <StreamingAgentBubble key={entry.actorId} entry={entry} />
      ))}
      {visibleSessionError ? (
        <SessionErrorAlert
          error={visibleSessionError}
          onDismiss={clearSessionError}
        />
      ) : visibleError ? (
        <SessionErrorAlert
          error={visibleError}
          onDismiss={() => setError(null)}
        />
      ) : null}
    </>
  ) : null;

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div
      className={cn(
      "flex flex-col",
        compact ? "h-full w-full relative" : "absolute inset-0",
      )}
    >
      {hasSkillRestartPrompt && (
        <div className="absolute top-2 left-1/2 z-20 flex w-[min(92vw,640px)] -translate-x-1/2 items-center gap-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900 shadow-sm">
          <AlertCircle className="h-4 w-4 shrink-0 text-sky-600" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{t("chat.skillRestartTitle", "Detected new skills")}</p>
            <p className="text-xs text-sky-700">
              {t("chat.skillRestartBody", "New or updated skills were detected. Restart the agent now to load them in the current runtime.")}
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => void handleRestartSkillsRuntime()}
            disabled={isRestartingSkillsRuntime}
            className="gap-2"
          >
            {isRestartingSkillsRuntime ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                {t("settings.mcp.restarting", "Restarting...")}
              </>
            ) : (
              <>
                <RefreshCw className="h-3 w-3" />
                {t("settings.mcp.restart", "Restart")}
              </>
            )}
          </Button>
          <button
            type="button"
            onClick={() => setHasSkillRestartPrompt(false)}
            className="rounded p-1 text-sky-700 hover:bg-sky-100"
            aria-label={t("common.close", "Close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Actors panel mounts in RightPanel for the 'actors' tab; trigger
       *  lives in App.tsx header alongside Knowledge / Changes. */}

      <NewSessionActorPicker
        open={!!pendingFirstMessage}
        onCancel={handlePickerCancel}
        onConfirm={(picks) => { void handlePickerConfirm(picks); }}
        teamId={sheetTeamId ?? ''}
        selfActorId={null}
      />

      {/* Inactivity warning - task still running but no events */}
      {inactivityWarning && isStreaming && isConnected && (
        <div className="absolute top-2 right-12 z-20 flex items-center gap-2 rounded-full bg-blue-100 px-3 py-1 text-xs text-blue-800">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t("chat.taskRunning", "Task running...")}
        </div>
      )}

      {/* ─── Archived session read-only bar ─── */}
      {isViewingArchived && (
        <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
          <button
            type="button"
            onClick={handleCloseArchivedSession}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft size={14} />
            <span>{t("chat.backToActiveSession", "Back to active session")}</span>
          </button>
          <div className="min-w-0 flex flex-1 items-center gap-1.5 text-xs text-muted-foreground">
            <Archive size={12} />
            <span className="truncate">
              {archivedSession?.title || t("chat.archivedSession", "Archived session")}
            </span>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-xs"
            disabled={isRestoringArchived}
            onClick={() => void handleRestoreArchivedSession()}
          >
            <RefreshCw className={cn("h-3 w-3", isRestoringArchived && "animate-spin")} />
            {t("chat.restoreSession", "Restore")}
          </Button>
        </div>
      )}

      {/* ─── Child session back bar ─── */}
      {isViewingChild && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-muted/30">
          <button
            type="button"
            onClick={() => useSessionStore.getState().setViewingChildSession(null)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft size={14} />
            <span>{t("chat.backToMainSession", "Back to main session")}</span>
          </button>
          <div className="flex items-center gap-1.5 ml-auto text-xs text-muted-foreground">
            <Bot size={12} />
            <span>Sub-agent</span>
            {childStreamingContent?.isStreaming && (
              <Loader2 size={12} className="animate-spin" />
            )}
          </div>
        </div>
      )}

      {workspaceBootstrapped && !workspaceReady && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 px-4 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <div>
              <p className="text-base font-medium">
                {t("chat.startingAgent", "Starting agent...")}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("chat.waitingForAgent", "Sessions are ready. Waiting for agent runtime to finish starting.")}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ─── Message List (fade on session switch; input stays stable) ─── */}
      <div
        className={cn(
          "flex-1 min-h-0 flex flex-col overflow-hidden",
          "transition-opacity duration-150 ease-in-out motion-reduce:transition-none",
        )}
        style={{ opacity: isViewingArchived || isViewingChild ? 1 : sessionFadeOpacity }}
      >
        {isViewingArchived ? (
          <MessageList
            ref={messageListRef}
            messages={archivedSessionMessages}
            activeSessionId={viewingArchivedSessionId}
            isStreaming={false}
            streamingMessageId={null}
            compact={compact}
            sessionDirectory={archivedSession?.directory}
          />
        ) : isViewingChild ? (
          isLoadingChildMessages ? (
            <div className="flex items-center justify-center flex-1">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <MessageList
              ref={messageListRef}
              messages={displayedChildSessionMessages}
              activeSessionId={viewingChildSessionId}
              isStreaming={!!childStreamingContent?.isStreaming}
              streamingMessageId={null}
              compact={compact}
            />
          )
        ) : (
          <MessageList
            ref={messageListRef}
            messages={displayMessages ?? []}
            activeSessionId={displaySessionId}
            isStreaming={isStreaming}
            streamingMessageId={streamingMessageId}
            compact={compact}
            emptyState={emptyState}
            bottomContent={messageBottomContent}
          />
        )}
      </div>

      {/* ─── Input Area (with Permission & Error UI above it) ─────────── */}
      {isViewingArchived ? (
        <div className="border-t border-border bg-background px-3 py-3">
          {archivedSessionError && (
            <div className="mb-2 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0">
                <div className="font-medium">
                  {t("chat.archivedSessionLoadError", "Could not load archived session")}
                </div>
                <div className="break-words text-xs text-destructive/80">
                  {archivedSessionError}
                </div>
              </div>
            </div>
          )}
          <div className="rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            {t("chat.restoreArchivedHint", "Restore this session to continue chatting")}
          </div>
        </div>
      ) : !isViewingChild && (
        activeInputQuestion ? (
          <QuestionInputDock
            compact={compact}
            pendingQuestion={activeInputQuestion}
            onHeightChange={handleInputHeightChange}
            bottomOffsetPx={terminalBottomOffset}
          />
        ) : (
          <ChatInputArea
            compact={compact}
            inputValue={inputValue}
            onInputChange={handleInputChange}
            attachedFiles={attachedFiles}
            onFilesChange={handleFilesChange}
            onRemoveFile={removeFile}
            engagedAgent={engagedAgent}
            onEngageAgent={(a) => {
              setEngagedAgentForSession(a);
              // Bootstrap a runtime for this (session, agent) if we haven't
              // already — otherwise the daemon has no process to deliver
              // the mention to and AgentSelectorDock has no RuntimeInfo
              // retain to read availableModels from.
              const sid = activeSessionId;
              const teamId = sheetTeamId;
              if (!sid || !teamId) return;
              const key = `${sid}:${a.id}`;
              if (ensuredRuntimesRef.current.has(key)) return;
              ensuredRuntimesRef.current.add(key);
              void (async () => {
                try {
                  const { startAgentRuntimesAsync } = await import("@/lib/session-create");
                  await startAgentRuntimesAsync({
                    sessionId: sid,
                    teamId,
                    agentActorIds: [a.id],
                  });
                } catch (e) {
                  console.warn("[ChatPanel] ensureAgentRuntime failed", e);
                  ensuredRuntimesRef.current.delete(key); // allow retry
                }
              })();
            }}
            onClearAgent={() => setEngagedAgentForSession(null)}
            imageFiles={imageFiles}
            onImageFilesChange={handleImageFilesChange}
            onRemoveImageFile={removeImageFile}
            onSubmit={handleSubmit}
            isStreaming={isStreaming}
            onAbort={abortSession}
            messageQueue={messageQueue}
            onRemoveFromQueue={removeFromQueue}
            onHeightChange={handleInputHeightChange}
            bottomOffsetPx={terminalBottomOffset}
            headerContent={
              <>
                {showInlineTodo ? (
                  <TodoList
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    todos={todos as any}
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    queue={messageQueue as any}
                    onRemoveFromQueue={removeFromQueue}
                    variant="inline"
                  />
                ) : null}
                <PendingPermissionInline />
              </>
            }
          />
        )
      )}

      {terminalOpen && workspacePath && (
        <TerminalPanel
          workspaceId={workspacePath}
          workspacePath={workspacePath}
          allowedRoots={[workspacePath]}
        />
      )}
    </div>
  );
}

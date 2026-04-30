import * as React from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, ArrowLeft, Bot, Loader2, RefreshCw, X } from "lucide-react";
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
import { ensureRoleSkillPlugin } from "../../lib/opencode/role-plugin-installer";
import { resolveSessionActivityOwner } from "@/lib/session-list-activity";
import type { PromptInputMessage } from "@/packages/ai/prompt-input";
import type { SendMessageFilePart } from "@/lib/opencode/sdk-types";
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

  // ── Session store selectors (reactive state only) ────────────────────
  const activeSessionId = useSessionStore(s => s.activeSessionId);
  const error = useSessionStore(s => s.error);
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

  // ── Child session viewing ──────────────────────────────────────────
  const viewingChildSessionId = useSessionStore(s => s.viewingChildSessionId);
  const childSessionMessages = useSessionStore(s =>
    s.viewingChildSessionId
      ? (s.childSessionMessages[s.viewingChildSessionId] || EMPTY_MESSAGES)
      : EMPTY_MESSAGES
  );
  const isLoadingChildMessages = useSessionStore(s => s.isLoadingChildMessages);
  const childStreamingContent = useStreamingStore(s =>
    viewingChildSessionId ? s.childSessionStreaming[viewingChildSessionId] : undefined
  );
  const isViewingChild = !!viewingChildSessionId;
  const showInlineTodo = React.useMemo(() => {
    if (isViewingChild) return false;
    if (todos.length === 0 && messageQueue.length === 0) return false;
    return !hasVisiblePendingPermissions(activeSessionId, sessions, pendingPermissions);
  }, [activeSessionId, isViewingChild, messageQueue.length, pendingPermissions, sessions, todos]);
  const displayedChildSessionMessages = React.useMemo(() => {
    if (!viewingChildSessionId) return EMPTY_MESSAGES;

    const hasLiveChildStreaming =
      !!childStreamingContent &&
      (childStreamingContent.isStreaming ||
        !!childStreamingContent.text ||
        !!childStreamingContent.reasoning);

    if (!hasLiveChildStreaming) {
      return childSessionMessages;
    }

    const hasStreamingPlaceholder = childSessionMessages.some((message) => message.isStreaming);
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
  }, [childSessionMessages, childStreamingContent, viewingChildSessionId]);
  const activeInputQuestion = React.useMemo(() => {
    if (!activeSessionId) return null;
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
  }, [activeSessionId, isViewingChild, pendingQuestions, sessions]);

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

  // ── Workspace store ───────────────────────────────────────────────────
  const workspacePath = useWorkspaceStore(s => s.workspacePath);
  const openCodeBootstrapped = useWorkspaceStore(s => s.openCodeBootstrapped);
  const openCodeReady = useWorkspaceStore(s => s.openCodeReady);
  const setOpenCodeBootstrapped = useWorkspaceStore(s => s.setOpenCodeBootstrapped);

  // ── Local state ───────────────────────────────────────────────────────
  const inputValue = draftInput;
  const setInputValue = setDraftInput;
  const [attachedFiles, setAttachedFiles] = React.useState<string[]>([]);
  const [imageFiles, setImageFiles] = React.useState<File[]>([]);
  const [hasSkillRestartPrompt, setHasSkillRestartPrompt] = React.useState(false);
  const [isRestartingSkillsRuntime, setIsRestartingSkillsRuntime] = React.useState(false);

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
  const activeMessages = useSessionStore(s =>
    s.activeSessionId ? s.sessions.find((ss) => ss.id === s.activeSessionId)?.messages : undefined
  );
  /** Shown messages lag store during fade so old session can fade out before swap */
  const [displaySessionId, setDisplaySessionId] = React.useState<string | null>(activeSessionId);
  const [sessionFadeOpacity, setSessionFadeOpacity] = React.useState(1);

  const displayMessages = useSessionStore((s) =>
    displaySessionId ? s.sessions.find((ss) => ss.id === displaySessionId)?.messages : undefined,
  );

  const SESSION_FADE_MS = 150;

  React.useEffect(() => {
    if (activeSessionId === null) {
      setDisplaySessionId(null);
      setSessionFadeOpacity(1);
    }
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
  // Merged to avoid race condition: team mode restarts OpenCode, which
  // would break a concurrent initProviderStore call.
  React.useEffect(() => {
    if (!openCodeReady) return;

    if (!workspacePath) {
      // No workspace yet, just init providers directly
      initProviderStore();
      return;
    }

    const { loadTeamConfig, applyTeamModelToOpenCode } = useTeamModeStore.getState();
    loadTeamConfig(workspacePath).then(async () => {
      if (useTeamModeStore.getState().teamMode) {
        // Team mode: apply team config (restarts OpenCode), then init providers.
        // applyTeamModelToOpenCode is idempotent — skips if config key unchanged.
        await applyTeamModelToOpenCode(workspacePath);
      }
      initProviderStore();
    });
  }, [openCodeReady, workspacePath]);

  // ── Team config hot reload via file watcher ─────────────────────────
  React.useEffect(() => {
    if (!openCodeBootstrapped || !workspacePath) return;
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
            await store.applyTeamModelToOpenCode(workspacePath);
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
  }, [openCodeReady, workspacePath]);

  React.useEffect(() => {
    const onSkillsChanged = () => setHasSkillRestartPrompt(true);
    window.addEventListener(SKILLS_CHANGED_EVENT, onSkillsChanged);
    return () => window.removeEventListener(SKILLS_CHANGED_EVENT, onSkillsChanged);
  }, []);

  // ── Team shortcuts hot reload via file watcher ─────────────────────────
  React.useEffect(() => {
    if (!openCodeBootstrapped || !workspacePath) return;
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
  }, [openCodeReady, workspacePath]);

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
    (activeMessages ?? []).some((m) => m.toolCalls?.some((tc) => tc.status === "calling" || tc.status === "waiting")),
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
    if (!openCodeBootstrapped || !workspacePath) return;

    const isWorkspaceChange =
      prevWorkspaceRef.current !== null &&
      prevWorkspaceRef.current !== workspacePath;
    prevWorkspaceRef.current = workspacePath;

      if (isWorkspaceChange) {
      resetSessions();
      }

    console.log("[ChatPanel] OpenCode bootstrapped, loading sessions for:", workspacePath);
        loadSessions(workspacePath)
      .then(() => setError(null))
      .catch((err) =>
        console.error("[ChatPanel] Failed to load sessions:", err),
      );
  }, [openCodeBootstrapped, workspacePath, loadSessions, resetSessions]);

  React.useEffect(() => {
    if (!openCodeReady || !workspacePath || !isTauri()) return;

    void ensureRoleSkillPlugin(workspacePath).then((result) => {
      console.log("[RolePlugin] Startup ensure result:", {
        workspacePath,
        ...result,
      });
      if (result.status === "conflict" || result.status === "failed") {
        console.warn("[RolePlugin] Failed to ensure role plugin config:", result);
      }
    });
  }, [openCodeReady, workspacePath]);

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

  const handleSubmit = async (message: PromptInputMessage) => {
    if (!openCodeReady) return;
    const text = message.text?.trim() || "";
    const mentions = message.mentions || [];
    const isPlanMode = !!(message as PromptInputMessage & { _planMode?: boolean })._planMode;

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

    // Add the processed text (with inline [File: ...] replacements)
    if (processedText.trim()) {
      parts.push(processedText.trim());
    }

    finalContent = parts.join("\n\n");

    // Save pasted images to workspace and build file parts
    let imageParts: SendMessageFilePart[] | undefined;
    if (imageFiles.length > 0) {
      const savedPaths: string[] = [];
      imageParts = await Promise.all(
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

    if (finalContent || (imageParts && imageParts.length > 0)) {
      sendMessage(finalContent || "", isPlanMode ? "plan" : undefined, imageParts);
    }

    setInputValue("");
    setAttachedFiles([]);
    setImageFiles([]);
  };

  const handleSuggestionClick = React.useCallback(
    (suggestion: string) => {
      // Keep all quick suggestions visually consistent with slash skill selection.
      setInputValue(`/{${suggestion}} `);
    },
    [setInputValue],
  );

  const handleRestartSkillsRuntime = React.useCallback(async () => {
    if (!workspacePath) return;
    setIsRestartingSkillsRuntime(true);
    try {
      const { restartOpencode } = await import("@/lib/opencode/restart");
      await restartOpencode(workspacePath);
      setHasSkillRestartPrompt(false);
    } catch (error) {
      console.error("[ChatPanel] Failed to restart OpenCode for skills:", error);
      setOpenCodeBootstrapped(false);
      setError(error instanceof Error ? error.message : "Failed to restart OpenCode");
    } finally {
      setIsRestartingSkillsRuntime(false);
    }
  }, [workspacePath, setOpenCodeBootstrapped, setError]);

  // ── Empty state with suggestions ──────────────────────────────────────
  const emptyState = React.useMemo(() => (
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
  ), [compact, t, suggestions, handleSuggestionClick]);

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
              {t("chat.skillRestartBody", "New or updated skills were detected. Restart OpenCode now to load them in the current runtime.")}
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

      {/* Inactivity warning - task still running but no events */}
      {inactivityWarning && isStreaming && isConnected && (
        <div className="absolute top-2 right-2 z-20 flex items-center gap-2 rounded-full bg-blue-100 px-3 py-1 text-xs text-blue-800">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t("chat.taskRunning", "Task running...")}
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

      {openCodeBootstrapped && !openCodeReady && (
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
        style={{ opacity: isViewingChild ? 1 : sessionFadeOpacity }}
      >
        {isViewingChild ? (
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
          />
        )}
      </div>

      {/* ─── Input Area (with Permission & Error UI above it) ─────────── */}
      {!isViewingChild && (
        activeInputQuestion ? (
          <QuestionInputDock
            compact={compact}
            pendingQuestion={activeInputQuestion}
            onHeightChange={handleInputHeightChange}
          />
        ) : (
          <ChatInputArea
            compact={compact}
            inputValue={inputValue}
            onInputChange={handleInputChange}
            attachedFiles={attachedFiles}
            onFilesChange={handleFilesChange}
            onRemoveFile={removeFile}
            imageFiles={imageFiles}
            onImageFilesChange={handleImageFilesChange}
            onRemoveImageFile={removeImageFile}
            onSubmit={handleSubmit}
            isStreaming={isStreaming}
            onAbort={abortSession}
            messageQueue={messageQueue}
            onRemoveFromQueue={removeFromQueue}
            onHeightChange={handleInputHeightChange}
            headerContent={
              <>
                {showInlineTodo ? (
                  <TodoList
                    todos={todos}
                    queue={messageQueue}
                    onRemoveFromQueue={removeFromQueue}
                    variant="inline"
                  />
                ) : null}
                <PendingPermissionInline />
                {sessionError && (
                  <SessionErrorAlert
                    error={sessionError}
                    onDismiss={clearSessionError}
                  />
                )}
                {error && !sessionError && (
                  <SessionErrorAlert
                    error={error}
                    onDismiss={() => setError(null)}
                  />
                )}
              </>
            }
          />
        )
      )}
    </div>
  );
}

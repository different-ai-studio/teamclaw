import * as React from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Loader2 } from "lucide-react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { cn, copyToClipboard } from "@/lib/utils";
import { type Message as StoreMessage, useSessionStore, getSessionById } from "@/stores/session";
import { useStreamingStore } from "@/stores/streaming";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/packages/ai/message";
import {
  DynamicUIMessage,
  extractUITreeFromResponse,
  parseStreamingUITree,
} from "@/lib/dynamic-ui";
import { ToolCallCard } from "./ToolCallCard";
import { ThinkingBlock } from "./ThinkingBlock";
import { UserMessageWithMentions } from "./UserMessageWithMentions";
import { MessageTokenUsage } from "./MessageTokenUsage";
import { MessageTokenSummary } from "./MessageTokenSummary";
import { MessageFeedback } from "./MessageFeedback";
import { MessageStarRating } from "./MessageStarRating";
import { RetrievedChunksCard } from "./RetrievedChunksCard";

/** Renders a single message with all its parts. Memoized to avoid re-renders when siblings change. */
export const ChatMessage = React.memo(function ChatMessage({
  message,
  activeSessionId,
  basePath,
  shouldShowThinking = true,
  showStarRating = false,
  tokenGroupInfo,
}: {
  message: StoreMessage;
  activeSessionId?: string | null;
  basePath?: string;
  shouldShowThinking?: boolean;
  showStarRating?: boolean;
  tokenGroupInfo?: {
    hideTokenUsage: boolean;
    groupSummary?: { steps: number; totalInput: number; totalOutput: number; totalCost: number };
  };
}) {
  const { t } = useTranslation();
  const isUser = message.role === "user";
  const [copied, setCopied] = React.useState(false);

  // Use streaming content for the actively streaming message.
  // PERF: Only the streaming message subscribes to high-frequency updates (trigger/content).
  // Non-streaming messages subscribe to streamingMessageId only (changes ~2x per conversation).
  const streamingMessageId = useStreamingStore(s => s.streamingMessageId);
  const isViewingThisSession = !!activeSessionId && message.sessionId === activeSessionId;
  const childStreamingState = useStreamingStore(s =>
    message.isStreaming && isViewingThisSession && activeSessionId
      ? s.childSessionStreaming[activeSessionId]
      : undefined,
  );
  const isChildSessionStreaming =
    message.isStreaming &&
    isViewingThisSession &&
    !!childStreamingState?.isStreaming;
  const isThisMessageStreaming =
    message.isStreaming &&
    (message.id === streamingMessageId || isChildSessionStreaming);

  // Only subscribe to per-frame updates when THIS message is streaming.
  // This prevents all other ChatMessage instances from re-rendering every frame.
  const streamingContent = useStreamingStore(s =>
    isThisMessageStreaming && !isChildSessionStreaming ? s.streamingContent : "",
  );
  const streamingUpdateTrigger = useStreamingStore(s =>
    isThisMessageStreaming && !isChildSessionStreaming ? s.streamingUpdateTrigger : 0,
  );
  const storeActiveSessionId = useSessionStore(s => s.activeSessionId);
  const resolvedSessionId = activeSessionId ?? storeActiveSessionId;

  // When streaming, get the latest message data from sessionLookupCache
  // which includes updated reasoning parts from typewriterTick
  const latestMessage = React.useMemo(() => {
    if (!isThisMessageStreaming || !resolvedSessionId) return message;
    const session = getSessionById(resolvedSessionId);
    if (!session) return message;
    const latest = session.messages.find(m => m.id === message.id);
    return latest || message;
  }, [isThisMessageStreaming, resolvedSessionId, message, streamingUpdateTrigger]);

  const textContent = isThisMessageStreaming
    ? (isChildSessionStreaming ? (childStreamingState?.text || "") : streamingContent)
    : (latestMessage.content || "");

  // Extract reasoning/thinking content from parts — memoized to avoid
  // re-filtering on every render during streaming.
  const { reasoningContent, hasReasoning, hasThinking } = React.useMemo(() => {
    const rParts = latestMessage.parts.filter((p) => p.type === "reasoning");
    const streamedReasoning = isChildSessionStreaming
      ? (childStreamingState?.reasoning || "")
      : "";
    const rContent = [
      rParts.map((p) => p.text || "").filter(Boolean).join("\n"),
      streamedReasoning,
    ].filter(Boolean).join("\n");
    return {
      reasoningContent: rContent,
      hasReasoning: rContent.length > 0,
      hasThinking: latestMessage.parts.some(
        (p) => p.type === "step-start" || p.type === "step-finish",
      ),
    };
  }, [childStreamingState?.reasoning, isChildSessionStreaming, latestMessage.parts]);

  const hasToolCalls = latestMessage.toolCalls && latestMessage.toolCalls.length > 0;

  const hasActiveToolCalls =
    latestMessage.toolCalls?.some(
      (tc) => tc.status === "calling" || tc.status === "waiting",
    ) ?? false;

  const showThinkingOnly =
    !isUser &&
    !textContent &&
    (hasThinking || hasReasoning) &&
    latestMessage.isStreaming &&
    !hasActiveToolCalls &&
    shouldShowThinking;

  const showLoadingIndicator =
    !isUser &&
    !textContent &&
    !hasThinking &&
    !hasReasoning &&
    !hasToolCalls &&
    latestMessage.isStreaming &&
    shouldShowThinking;

  // Try to extract UITree from assistant message
  const uiState = React.useMemo(() => {
    if (isUser || !textContent)
      return { tree: null, isComplete: false, elementCount: 0 };

    if (latestMessage.isStreaming) {
      return parseStreamingUITree(textContent);
    } else {
      const tree = extractUITreeFromResponse(textContent);
      return {
        tree,
        isComplete: true,
        elementCount: tree ? Object.keys(tree.elements).length : 0,
      };
    }
  }, [isUser, latestMessage.isStreaming, textContent]);

  const uiTree = uiState.tree;
  const isStreamingUI = latestMessage.isStreaming && uiTree !== null;

  // Tool-call-only messages get tighter spacing
  const isToolCallOnly = !isUser && !textContent && hasToolCalls && !hasReasoning && !showLoadingIndicator;

  const handleCopy = React.useCallback(async () => {
    if (!textContent.trim()) return;
    await copyToClipboard(textContent, t("common.copied", "Copied!"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [textContent, t]);

  const shouldShowAssistantCopyAction =
    !isUser &&
    !latestMessage.isStreaming &&
    Boolean(textContent) &&
    !(tokenGroupInfo?.hideTokenUsage ?? false);

  return (
    <div className={cn("group/msg", isToolCallOnly ? "mb-0.5" : "mb-1.5")} data-testid="chat-message" data-message-role={message.role}>
      {/* Thinking indicator - MUST be first for assistant messages during streaming */}
      {showThinkingOnly && !hasReasoning && (
        <div className="flex items-start gap-2 pl-1 mb-2">
          <ThinkingBlock
            content={t("chat.analyzing", "Agent is analyzing and planning...")}
            isStreaming={true}
            isOpen={false}
          />
        </div>
      )}

      {/* Loading indicator */}
      {showLoadingIndicator && (
        <div className="mt-2">
          <Message from="assistant" basePath={basePath}>
            <MessageContent>
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm shimmer-text">{t("chat.planningMoves", "Planning next moves")}</span>
              </div>
            </MessageContent>
          </Message>
        </div>
      )}

      {/* Reasoning block - always before main content */}
      {!isUser && hasReasoning && (
        <div className="mb-0.5">
          <ThinkingBlock
            content={reasoningContent}
            isStreaming={latestMessage.isStreaming && !textContent && !hasToolCalls}
            isOpen={false}
          />
        </div>
      )}

      {/* User message */}
      {isUser && (
        <Message from="user" basePath={basePath}>
          <MessageContent>
            <UserMessageWithMentions content={textContent} basePath={basePath} />
          </MessageContent>
        </Message>
      )}

      {/* User message actions */}
      {isUser && !latestMessage.isStreaming && (
        <div className={cn("flex justify-end mt-1 pr-1 transition-opacity", copied ? "opacity-100" : "opacity-0 group-hover/msg:opacity-100")}>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground/70 hover:text-foreground hover:bg-muted/40 transition-colors"
            title={copied ? t("common.copied", "Copied!") : t("common.copy", "Copy")}
          >
            {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copied ? t("common.copied", "Copied!") : t("common.copy", "Copy")}</span>
          </button>
        </div>
      )}

      {/* Retrieved chunks - show for user messages with RAG results */}
      {isUser && latestMessage.retrievedChunks && latestMessage.retrievedChunks.length > 0 && (
        <div className="mt-2">
          <RetrievedChunksCard chunks={latestMessage.retrievedChunks} />
        </div>
      )}

      {/* Assistant message - either dynamic UI or text */}
      {!isUser && textContent && (
        <>
          {uiTree ? (
            <div className="mt-2">
              <ErrorBoundary scope="Dynamic UI" inline>
                <DynamicUIMessage tree={uiTree} loading={isStreamingUI} />
              </ErrorBoundary>
              {isStreamingUI && (
                <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                  <div className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                  <span>{t("chat.generatingComponents", "Generating... ({{count}} components)", { count: uiState.elementCount })}</span>
                </div>
              )}
            </div>
          ) : (
            <Message from="assistant" basePath={basePath}>
              <MessageContent>
                <MessageResponse>{textContent}</MessageResponse>
                {latestMessage.isStreaming && textContent && (
                  <span className="inline-flex items-center gap-0.5 ml-1.5 align-middle">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-[bounce_1s_ease-in-out_infinite]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-[bounce_1s_ease-in-out_0.2s_infinite]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-[bounce_1s_ease-in-out_0.4s_infinite]" />
                  </span>
                )}
              </MessageContent>
            </Message>
          )}
        </>
      )}

      {/* Copy action for assistant text responses */}
      {shouldShowAssistantCopyAction && (
        <div className={cn("pl-1 mt-1 transition-opacity", copied ? "opacity-100" : "opacity-0 group-hover/msg:opacity-100")}>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground/70 hover:text-foreground hover:bg-muted/40 transition-colors"
            title={copied ? t("common.copied", "Copied!") : t("common.copy", "Copy")}
          >
            {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copied ? t("common.copied", "Copied!") : t("common.copy", "Copy")}</span>
          </button>
        </div>
      )}

      {/* Tool calls */}
      {!isUser && hasToolCalls && (
        <div className="mt-1 space-y-0.5 pl-1">
          {latestMessage.toolCalls!.map((toolCall) => (
            <ToolCallCard key={toolCall.id} toolCall={toolCall} />
          ))}
        </div>
      )}

      {/* Token usage summary + feedback for assistant messages */}
      {!isUser && !latestMessage.isStreaming && latestMessage.tokens && !tokenGroupInfo?.hideTokenUsage && (
        <div className="pl-1 group">
          <div className="flex items-start gap-2">
            {tokenGroupInfo?.groupSummary ? (
              <MessageTokenSummary summary={tokenGroupInfo.groupSummary} />
            ) : (
              <MessageTokenUsage tokens={latestMessage.tokens} cost={latestMessage.cost} />
            )}
            <div className="mt-1">
              <MessageFeedback
                sessionId={latestMessage.sessionId}
                messageId={latestMessage.id}
              />
            </div>
          </div>
          {showStarRating && (
            <MessageStarRating
              sessionId={latestMessage.sessionId}
              messageId={latestMessage.id}
            />
          )}
        </div>
      )}
    </div>
  );
});

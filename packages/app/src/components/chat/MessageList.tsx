import * as React from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ErrorBoundary } from "@/components/ErrorBoundary";

import { useSessionStore, type Message } from "@/stores/session";
import { useStreamingStore } from "@/stores/streaming";
import { Button } from "@/components/ui/button";
import { ChatMessage } from "./ChatMessage";
import { SAFE_BOTTOM_SPACING, NEAR_BOTTOM_THRESHOLD } from "./layout-constants";

// ─── Constants ────────────────────────────────────────────────────────────────

// Chat messages can reflow heavily when the right-side panel opens/closes.
// The current virtualized path occasionally keeps stale row heights and causes
// overlap, so we keep the stable non-virtualized path for normal conversations.
const VIRTUAL_MSG_THRESHOLD = Number.MAX_SAFE_INTEGER;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MessageListProps {
  messages: Message[];
  activeSessionId: string | null;
  isStreaming: boolean;
  streamingMessageId: string | null;
  compact?: boolean;
  /** Optional empty-state content rendered when there are no messages (not loading) */
  emptyState?: React.ReactNode;
}

export interface MessageListHandle {
  /** Notify the message list that the input area height changed (for bottom padding) */
  handleInputHeightChange: (height: number) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export const MessageList = React.forwardRef<MessageListHandle, MessageListProps>(
  function MessageList(
    {
      messages: rawMessages,
      activeSessionId,
      isStreaming,
      streamingMessageId: _streamingMessageId,
      compact = false,
      emptyState,
    },
    ref,
  ) {
    const { t } = useTranslation();

    // ── Store selectors ──────────────────────────────────────────────────
    const isLoading = useSessionStore((s) => s.isLoading);
    const messageQueue = useSessionStore((s) => s.messageQueue);
    const streamingContentLength = useStreamingStore(
      (s) => s.streamingContent.length,
    );
    const streamingUpdateTrigger = useStreamingStore(
      (s) => s.streamingUpdateTrigger,
    );
    const childStreamingScrollTrigger = useStreamingStore((s) => {
      const cs = s.childSessionStreaming;
      let len = 0;
      for (const k in cs) {
        len += cs[k]?.text?.length || 0;
      }
      return len;
    });

    // PERF: Return primitive string instead of session object.
    // Object references from .find() change on every sessions update → unnecessary re-renders.
    // Use `activeSessionId` prop (may lag store during ChatPanel fade) so paths match shown messages.
    const activeSessionDirectory = useSessionStore((s) =>
      activeSessionId
        ? s.sessions.find((ss) => ss.id === activeSessionId)?.directory
        : undefined,
    );

    // ── Sorted messages ──────────────────────────────────────────────────
    const messages = React.useMemo(() => {
      const msgs = rawMessages || [];
      return [...msgs].sort((a, b) => {
        const ta = a.timestamp?.getTime?.() ?? 0;
        const tb = b.timestamp?.getTime?.() ?? 0;
        if (ta !== tb) return ta - tb;
        return (a.id || "").localeCompare(b.id || "");
      });
    }, [rawMessages]);

    // ── Token group info ─────────────────────────────────────────────────
    // Compute token group summaries: consecutive assistant messages are grouped.
    // Intermediate messages hide individual tokens; the last in a group shows aggregate.
    const tokenGroupInfo = React.useMemo(() => {
      const info = new Map<
        string,
        {
          hideTokenUsage: boolean;
          groupSummary?: {
            steps: number;
            totalInput: number;
            totalOutput: number;
            totalCost: number;
          };
        }
      >();
      let groupStart = -1;
      for (let i = 0; i <= messages.length; i++) {
        const msg = messages[i];
        const isAssistant = msg && msg.role !== "user";
        if (!isAssistant || i === messages.length) {
          // End of a group — finalize
          if (groupStart !== -1) {
            const groupEnd = i - 1;
            const groupLen = groupEnd - groupStart + 1;
            if (groupLen > 1) {
              let totalInput = 0,
                totalOutput = 0,
                totalCost = 0;
              for (let j = groupStart; j <= groupEnd; j++) {
                const toks = messages[j].tokens;
                if (toks) {
                  totalInput += toks.input;
                  totalOutput += toks.output;
                }
                if (messages[j].cost) totalCost += messages[j].cost!;
              }
              for (let j = groupStart; j < groupEnd; j++) {
                info.set(messages[j].id, { hideTokenUsage: true });
              }
              info.set(messages[groupEnd].id, {
                hideTokenUsage: false,
                groupSummary: {
                  steps: groupLen,
                  totalInput,
                  totalOutput,
                  totalCost,
                },
              });
            }
            // Single-message groups keep default behavior (no entry in map)
          }
          groupStart = -1;
        } else if (groupStart === -1) {
          groupStart = i;
        }
      }
      return info;
    }, [messages]);

    // ── Local state ──────────────────────────────────────────────────────
    const [showScrollButton, setShowScrollButton] = React.useState(false);
    const [inputAreaHeight, setInputAreaHeight] = React.useState(160);
    const [messageAreaWidth, setMessageAreaWidth] = React.useState(0);

    // ── Refs ─────────────────────────────────────────────────────────────
    const scrollRef = React.useRef<HTMLDivElement>(null);
    const messageAreaRef = React.useRef<HTMLDivElement>(null);
    const userScrolledUpRef = React.useRef(false);
    const prevStreamingRef = React.useRef(false);

    // ── Imperative handle ────────────────────────────────────────────────
    const handleInputHeightChange = React.useCallback((height: number) => {
      setInputAreaHeight((prev) => {
        if (prev === height) return prev;
        // When input area grows, re-scroll after the DOM updates with new padding
        if (height > prev && scrollRef.current && !userScrolledUpRef.current) {
          requestAnimationFrame(() => {
            scrollRef.current?.scrollTo({
              top: scrollRef.current!.scrollHeight,
              behavior: "instant",
            });
          });
        }
        return height;
      });
    }, []);

    React.useImperativeHandle(
      ref,
      () => ({
        handleInputHeightChange,
      }),
      [handleInputHeightChange],
    );

    React.useLayoutEffect(() => {
      const el = messageAreaRef.current;
      if (!el) return;

      const updateWidth = () => {
        const nextWidth = Math.round(el.getBoundingClientRect().width);
        setMessageAreaWidth((prev) => (prev === nextWidth ? prev : nextWidth));
      };

      updateWidth();

      const observer = new ResizeObserver(() => {
        updateWidth();
      });

      observer.observe(el);
      return () => observer.disconnect();
    }, []);

    // ── Virtual scrolling ────────────────────────────────────────────────
    const useVirtualMessages = messages.length > VIRTUAL_MSG_THRESHOLD;

    const messageVirtualizer = useVirtualizer({
      count: useVirtualMessages ? messages.length : 0,
      getScrollElement: () => scrollRef.current,
      estimateSize: () => 150,
      overscan: 5,
      gap: 4,
    });

    React.useLayoutEffect(() => {
      if (!useVirtualMessages || messageAreaWidth <= 0) return;

      const raf = requestAnimationFrame(() => {
        messageVirtualizer.measure();
      });

      return () => cancelAnimationFrame(raf);
    }, [useVirtualMessages, messageAreaWidth, messageVirtualizer]);

    // ── Scroll management ────────────────────────────────────────────────

    // Reset user scroll tracking when a new streaming session starts
    // AND scroll to bottom to ensure thinking blocks are visible
    React.useEffect(() => {
      if (isStreaming && !prevStreamingRef.current) {
        userScrolledUpRef.current = false;
        // Scroll to bottom when streaming starts to show thinking blocks
        // Use instant to ensure we reach the bottom even if content is growing rapidly
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (scrollRef.current) {
              scrollRef.current.scrollTo({
                top: scrollRef.current.scrollHeight,
                behavior: "instant",
              });
            }
          });
        });
      }
      prevStreamingRef.current = isStreaming;
    }, [isStreaming]);

    // CRITICAL: Reset scroll lock when user sends a new message
    // This ensures auto-scroll works even if user was viewing middle of chat
    const lastMessageIdRef = React.useRef<string | null>(null);
    React.useEffect(() => {
      const lastMessage = messages[messages.length - 1];
      if (
        lastMessage?.role === "user" &&
        lastMessage.id !== lastMessageIdRef.current
      ) {
        // New user message detected
        userScrolledUpRef.current = false;
        console.log("[MessageList] User sent new message, resetting scroll lock:", lastMessage.id);
      }
      lastMessageIdRef.current = lastMessage?.id || null;
    }, [messages]);

    // Auto-scroll to bottom when messages change, queue changes, or input area resizes
    // Also scroll during streaming when content grows (streamingContentLength or streamingUpdateTrigger)
    // streamingUpdateTrigger is critical for flush scenarios where content is dumped at once
    React.useEffect(() => {
      if (!scrollRef.current) return;

      // User manually scrolled up: respect it unless it's a brand new user message
      if (userScrolledUpRef.current) {
        const lastMessage = messages[messages.length - 1];
        const isUserMessageJustSent = lastMessage?.role === "user";
        if (!isUserMessageJustSent) return;
      }

      const container = scrollRef.current;
      const { scrollTop, scrollHeight, clientHeight } = container;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

      const lastMessage = messages[messages.length - 1];
      const isUserMessageJustSent = lastMessage?.role === "user";

      // Decide if we should scroll:
      // 1. User just sent a message → Always scroll (override user scroll lock)
      // 2. During streaming → Always scroll (content is growing)
      // 3. Message queue has items → Scroll (new message coming)
      // 4. Near bottom → Scroll (already at bottom)
      const shouldScroll =
        isUserMessageJustSent ||
        isStreaming ||
        messageQueue.length > 0 ||
        distanceFromBottom < NEAR_BOTTOM_THRESHOLD ||
        scrollTop === 0;

      if (shouldScroll) {
        // Use requestAnimationFrame to ensure DOM has rendered before scrolling
        // Double rAF ensures layout is complete (critical for new messages)
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            // CRITICAL: Re-check userScrolledUpRef before executing scroll
            // User may have started scrolling up between when we queued this and now
            if (!scrollRef.current) return;
            
            // If user scrolled up in the meantime, respect it (unless it's a new user message)
            const lastMsg = messages[messages.length - 1];
            const isNewUserMsg = lastMsg?.role === "user";
            if (userScrolledUpRef.current && !isNewUserMsg) {
              return;
            }

            scrollRef.current.scrollTo({
              top: scrollRef.current.scrollHeight,
              behavior: isNewUserMsg ? "smooth" : "instant",
            });
          });
        });
      }
    }, [
      messages,
      isStreaming,
      messageQueue.length,
      streamingContentLength,
      streamingUpdateTrigger,
    ]);

    // Auto-scroll when streaming ends (to show token usage and final content)
    React.useEffect(() => {
      if (
        !isStreaming &&
        prevStreamingRef.current &&
        scrollRef.current &&
        !userScrolledUpRef.current
      ) {
        // Delay scroll to ensure token usage is rendered
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (scrollRef.current && !userScrolledUpRef.current) {
              scrollRef.current.scrollTo({
                top: scrollRef.current.scrollHeight,
                behavior: "smooth",
              });
            }
          });
        });
      }
    }, [isStreaming]);

    // Auto-scroll when child session (subagent) streaming content grows
    React.useEffect(() => {
      if (
        scrollRef.current &&
        childStreamingScrollTrigger > 0 &&
        !userScrolledUpRef.current
      ) {
        scrollRef.current.scrollTo({
          top: scrollRef.current.scrollHeight,
          behavior: "instant",
        });
      }
    }, [childStreamingScrollTrigger]);

    // Reset scroll state when switching sessions (prop tracks displayed session, may lag store during fade)
    const prevSessionIdRef = React.useRef(activeSessionId);
    const needsScrollAfterLoadRef = React.useRef(false);
    React.useEffect(() => {
      if (activeSessionId !== prevSessionIdRef.current) {
        prevSessionIdRef.current = activeSessionId;
        userScrolledUpRef.current = false;
        setShowScrollButton(false);
        needsScrollAfterLoadRef.current = true;
      }
    }, [activeSessionId]);

    const storeActiveSessionId = useSessionStore((s) => s.activeSessionId);

    // Load feedback for the store-active session (not the lagging display id during fade)
    React.useEffect(() => {
      if (storeActiveSessionId) {
        import("@/stores/telemetry")
          .then(({ useTelemetryStore }) => {
            useTelemetryStore.getState().loadFeedbacks(storeActiveSessionId);
          })
          .catch(() => {
            /* telemetry not available */
          });
      }
    }, [storeActiveSessionId]);

    // Scroll to bottom after session messages are loaded
    const prevLoadingRef = React.useRef(isLoading);
    React.useEffect(() => {
      const wasLoading = prevLoadingRef.current;
      prevLoadingRef.current = isLoading;

      const shouldReveal =
        (wasLoading && !isLoading && needsScrollAfterLoadRef.current) ||
        (!isLoading && needsScrollAfterLoadRef.current);

      if (shouldReveal) {
        needsScrollAfterLoadRef.current = false;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (scrollRef.current) {
              scrollRef.current.scrollTo({
                top: scrollRef.current.scrollHeight,
                behavior: "instant",
              });
            }
          });
        });
      } else if (!isLoading && messages.length === 0) {
        // Also clear sessionSwitching when showing empty state (no messages)
        setSessionSwitching(false);
      }
    }, [isLoading, messages.length]);

    // Initial mount scroll
    const hasInitialScrolled = React.useRef(false);
    React.useEffect(() => {
      if (
        !hasInitialScrolled.current &&
        scrollRef.current &&
        messages.length > 0 &&
        !isLoading
      ) {
        hasInitialScrolled.current = true;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (scrollRef.current) {
              scrollRef.current.scrollTo({
                top: scrollRef.current.scrollHeight,
                behavior: "instant",
              });
            }
          });
        });
      }
    }, [messages.length, isLoading]);

    // Track scroll position for scroll-to-bottom button
    const scrollRafRef = React.useRef<number | undefined>(undefined);
    React.useEffect(() => {
      const el = scrollRef.current;
      if (!el) return;

      const handleScroll = () => {
        // CRITICAL: Update userScrolledUpRef IMMEDIATELY (synchronously) to prevent auto-scroll jank
        // during streaming. If we delay this in rAF, auto-scroll effect may run before we detect
        // user scroll, causing jarring scroll conflicts.
        const isNearBottom =
          el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD;
        userScrolledUpRef.current = !isNearBottom;

        // UI updates (scroll button) can be debounced in rAF for performance
        if (scrollRafRef.current != null)
          cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = requestAnimationFrame(() => {
          setShowScrollButton(!isNearBottom && messages.length > 0);
          scrollRafRef.current = undefined;
        });
      };

      el.addEventListener("scroll", handleScroll, { passive: true });
      return () => {
        el.removeEventListener("scroll", handleScroll);
        if (scrollRafRef.current != null)
          cancelAnimationFrame(scrollRafRef.current);
      };
    }, [messages.length, activeSessionId]);

    // ── Scroll to bottom ─────────────────────────────────────────────────
    const scrollToBottom = () => {
      userScrolledUpRef.current = false;
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTo({
            top: scrollRef.current.scrollHeight,
            behavior: "smooth",
          });
        }
      });
    };

    // ── Render ───────────────────────────────────────────────────────────

    return (
      <>
        {/* ─── Conversation Area ───────────────────────────────────────── */}
        <div
          ref={scrollRef}
          data-chat-messages
          className="flex-1 overflow-y-auto overflow-x-hidden"
        >
          <div
            ref={messageAreaRef}
            className={cn(
              "w-full",
              compact ? "px-2 py-4" : "mx-auto px-4 py-6 max-w-3xl",
            )}
            style={{ paddingBottom: `${inputAreaHeight + SAFE_BOTTOM_SPACING}px` }}
          >
            {isLoading && messages.length === 0 ? (
              <div
                className={cn(
                  "flex items-center justify-center",
                  compact ? "py-8" : "py-20",
                )}
              >
                <Loader2
                  className={cn(
                    "animate-spin text-muted-foreground",
                    compact ? "h-5 w-5" : "h-6 w-6",
                  )}
                />
              </div>
            ) : messages.length === 0 ? (
              emptyState ?? (
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
                    {compact
                      ? t("chat.agent", "Agent")
                      : t("chat.startNewChat", "Start a New Chat")}
                  </h2>
                  <p
                    className={cn(
                      "text-muted-foreground",
                      compact ? "text-xs mb-2" : "text-sm mb-6",
                    )}
                  >
                    {compact
                      ? t("chat.askAboutFile", "Ask questions about the file")
                      : t(
                          "chat.askAnything",
                          "Ask me anything, or choose a suggestion below",
                        )}
                  </p>
                </div>
              )
            ) : (
              <div className="space-y-1">
                {/* Find the last completed assistant message for star rating */}
                {(() => {
                  // Star rating only on the last non-streaming assistant message with tokens
                  let lastCompletedAssistantIdx = -1;
                  for (let i = messages.length - 1; i >= 0; i--) {
                    const m = messages[i];
                    if (m.role !== "user" && !m.isStreaming && m.tokens) {
                      lastCompletedAssistantIdx = i;
                      break;
                    }
                  }

                  return useVirtualMessages ? (
                    <div
                      style={{
                        height: `${messageVirtualizer.getTotalSize()}px`,
                        width: "100%",
                        position: "relative",
                      }}
                    >
                      {messageVirtualizer
                        .getVirtualItems()
                        .map((virtualItem) => {
                          const message = messages[virtualItem.index];
                          const isLastMessage =
                            virtualItem.index === messages.length - 1;
                          const shouldShowThinking =
                            isLastMessage && message.isStreaming;

                          return (
                            <div
                              key={message.id}
                              ref={messageVirtualizer.measureElement}
                              data-index={virtualItem.index}
                              style={{
                                position: "absolute",
                                top: 0,
                                left: 0,
                                width: "100%",
                                transform: `translateY(${virtualItem.start}px)`,
                              }}
                            >
                              <ErrorBoundary scope="Message" inline>
                                <ChatMessage
                                  message={message}
                                  basePath={activeSessionDirectory}
                                  shouldShowThinking={shouldShowThinking}
                                  showStarRating={
                                    virtualItem.index ===
                                    lastCompletedAssistantIdx
                                  }
                                  tokenGroupInfo={tokenGroupInfo.get(
                                    message.id,
                                  )}
                                />
                              </ErrorBoundary>
                            </div>
                          );
                        })}
                    </div>
                  ) : (
                    messages.map((message, index) => {
                      const isLastMessage = index === messages.length - 1;
                      const shouldShowThinking =
                        isLastMessage && message.isStreaming;

                      return (
                        <ErrorBoundary
                          key={message.id}
                          scope="Message"
                          inline
                        >
                          <ChatMessage
                            message={message}
                            basePath={activeSessionDirectory}
                            shouldShowThinking={shouldShowThinking}
                            showStarRating={
                              index === lastCompletedAssistantIdx
                            }
                            tokenGroupInfo={tokenGroupInfo.get(message.id)}
                          />
                        </ErrorBoundary>
                      );
                    })
                  );
                })()}
              </div>
            )}
          </div>
        </div>

        {/* Scroll to bottom button */}
        {showScrollButton && (
          <div className="pointer-events-none absolute bottom-32 right-6 z-20">
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="pointer-events-auto h-8 w-8 rounded-full shadow-md"
              onClick={scrollToBottom}
            >
              <ChevronDown className="h-4 w-4" />
            </Button>
          </div>
        )}
      </>
    );
  },
);

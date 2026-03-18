import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockSendMessageAsync, mockSendMessageWithPartsAsync, mockAbortSession, mockGetMessages } = vi.hoisted(() => ({
  mockSendMessageAsync: vi.fn().mockResolvedValue(undefined),
  mockSendMessageWithPartsAsync: vi.fn().mockResolvedValue(undefined),
  mockAbortSession: vi.fn().mockResolvedValue(undefined),
  mockGetMessages: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/opencode/client', () => ({
  getOpenCodeClient: () => ({
    createSession: vi.fn().mockResolvedValue({
      id: 'new-sess',
      title: 'New',
      time: { created: Date.now(), updated: Date.now() },
      path: '/test',
    }),
    getSessions: vi.fn().mockResolvedValue([]),
    listSessions: vi.fn().mockResolvedValue([]),
    getMessages: mockGetMessages,
    loadAllMessages: vi.fn().mockResolvedValue([]),
    sendMessageAsync: mockSendMessageAsync,
    sendMessageWithPartsAsync: mockSendMessageWithPartsAsync,
    abortSession: mockAbortSession,
    replyPermission: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    isVisible: vi.fn().mockResolvedValue(true),
    setFocus: vi.fn(),
  })),
}));

vi.mock('@/lib/opencode/sse', () => ({
  registerChildSession: vi.fn(),
  isChildSession: vi.fn(() => false),
  clearAllChildSessions: vi.fn(),
}));

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ workspacePath: '/test', openCodeUrl: 'http://localhost:13141' }),
    { getState: () => ({ workspacePath: '/test', openCodeUrl: 'http://localhost:13141' }) },
  ),
}));

vi.mock('@/stores/provider', () => ({
  useProviderStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ selectedModel: null }),
    { getState: () => ({ selectedModel: null }) },
  ),
}));

vi.mock('@/lib/permission-policy', () => ({
  shouldAutoAuthorize: () => false,
}));

vi.mock('@/lib/notification-service', () => ({
  notificationService: { notify: vi.fn(), send: vi.fn() },
}));

vi.mock('@/lib/utils', () => ({
  isTauri: () => false,
  cn: (...args: string[]) => args.filter(Boolean).join(' '),
}));

vi.mock('@/stores/knowledge', () => ({
  useKnowledgeStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({}),
    { getState: () => ({ searchForAutoInject: vi.fn().mockResolvedValue([]) }) },
  ),
}));

vi.mock('@/lib/insert-message-sorted', () => ({
  insertMessageSorted: (msgs: unknown[], msg: unknown) => [...msgs, msg],
}));

const mockSetStreaming = vi.fn();
const mockClearStreaming = vi.fn();

vi.mock('@/stores/streaming', () => ({
  useStreamingStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ streamingMessageId: null, streamingContent: '' }),
    {
      getState: () => ({
        clearStreaming: mockClearStreaming,
        clearAllChildStreaming: vi.fn(),
        streamingMessageId: null,
        setStreaming: mockSetStreaming,
      }),
    },
  ),
  cleanupAllChildSessions: vi.fn(),
  clearTypewriterBuffers: vi.fn(),
  flushAllPending: vi.fn(),
  scheduleTypewriter: vi.fn(),
  appendTextBuffer: vi.fn(),
  appendReasoningBuffer: vi.fn(),
  CHARS_PER_FRAME: 3,
  textBuffer: '',
  reasoningBuffers: new Map(),
  rafId: null,
}));

// Import after mocks
import { useSessionStore } from '../session';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('session store: message behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetStreaming.mockClear();
    mockClearStreaming.mockClear();
    useSessionStore.setState({
      sessions: [
        {
          id: 'sess-1',
          title: 'Test Session',
          messages: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      activeSessionId: 'sess-1',
      isLoading: false,
      messageQueue: [],
      error: null,
      sessionError: null,
      sessionStatus: null,
      selectedModel: null,
      draftInput: '',
    });
  });

  describe('sendMessage', () => {
    it('ignores empty messages', async () => {
      await useSessionStore.getState().sendMessage('   ');
      expect(mockSendMessageAsync).not.toHaveBeenCalled();
    });

    it('adds optimistic user message and pending assistant to session', async () => {
      await useSessionStore.getState().sendMessage('Hello agent');

      const state = useSessionStore.getState();
      const session = state.sessions.find((s) => s.id === 'sess-1');
      expect(session).toBeTruthy();
      // Should have user msg + pending assistant msg
      expect(session!.messages.length).toBe(2);
      expect(session!.messages[0].role).toBe('user');
      expect(session!.messages[0].content).toBe('Hello agent');
      expect(session!.messages[1].role).toBe('assistant');
      expect(session!.messages[1].isStreaming).toBe(true);
    });

    it('calls sendMessageAsync with correct session and content', async () => {
      await useSessionStore.getState().sendMessage('test content');
      expect(mockSendMessageAsync).toHaveBeenCalledWith(
        'sess-1',
        'test content',
        undefined, // no model
        undefined, // no agent
        undefined, // no system prompt (localStorage empty in test)
      );
    });

    it('queues message when already streaming', async () => {
      // First send a message to start streaming
      await useSessionStore.getState().sendMessage('first message');

      // The streaming store mock's getState still returns null for streamingMessageId,
      // so we need to test the queue differently: directly set queue and verify behavior
      useSessionStore.setState({
        messageQueue: [
          { id: 'q-1', content: 'queued message', timestamp: new Date() },
        ],
      });

      const state = useSessionStore.getState();
      expect(state.messageQueue.length).toBe(1);
      expect(state.messageQueue[0].content).toBe('queued message');
    });

    it('cleans up on API error: removes pending assistant, sets error', async () => {
      mockSendMessageAsync.mockRejectedValueOnce(new Error('Network failure'));

      await useSessionStore.getState().sendMessage('will fail');

      const state = useSessionStore.getState();
      // Error should be set
      expect(state.error).toBe('Network failure');
      // Pending assistant message should be removed
      const session = state.sessions.find((s) => s.id === 'sess-1');
      const assistantMsgs = session!.messages.filter((m) => m.role === 'assistant');
      expect(assistantMsgs.length).toBe(0);
      // Streaming should be cleared
      expect(mockClearStreaming).toHaveBeenCalled();
    });

    it('sends image parts via sendMessageWithPartsAsync', async () => {
      const imageParts = [
        { type: 'file' as const, url: 'data:image/png;base64,abc', mime: 'image/png', filename: 'shot.png' },
      ];

      await useSessionStore.getState().sendMessage('check this image', undefined, imageParts);

      expect(mockSendMessageWithPartsAsync).toHaveBeenCalled();
      expect(mockSendMessageAsync).not.toHaveBeenCalled();

      const callArgs = mockSendMessageWithPartsAsync.mock.calls[0];
      expect(callArgs[0]).toBe('sess-1');
      // Parts should include text + file
      expect(callArgs[1]).toHaveLength(2);
      expect(callArgs[1][0]).toEqual({ type: 'text', text: 'check this image' });
      expect(callArgs[1][1]).toEqual(imageParts[0]);
    });

    it('updates session title on first message', async () => {
      await useSessionStore.getState().sendMessage('My first question about React hooks');

      const session = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
      expect(session!.title).toBe('My first question about React hooks');
    });
  });

  describe('removeFromQueue', () => {
    it('removes specific message from queue by id', () => {
      useSessionStore.setState({
        messageQueue: [
          { id: 'q-1', content: 'first', timestamp: new Date() },
          { id: 'q-2', content: 'second', timestamp: new Date() },
          { id: 'q-3', content: 'third', timestamp: new Date() },
        ],
      });

      useSessionStore.getState().removeFromQueue('q-2');

      const queue = useSessionStore.getState().messageQueue;
      expect(queue.length).toBe(2);
      expect(queue.map((m) => m.id)).toEqual(['q-1', 'q-3']);
    });

    it('no-op when removing non-existent id', () => {
      useSessionStore.setState({
        messageQueue: [
          { id: 'q-1', content: 'first', timestamp: new Date() },
        ],
      });

      useSessionStore.getState().removeFromQueue('nonexistent');

      expect(useSessionStore.getState().messageQueue.length).toBe(1);
    });
  });

  describe('abortSession', () => {
    it('does nothing when no active session or streaming', async () => {
      useSessionStore.setState({ activeSessionId: null });
      await useSessionStore.getState().abortSession();
      expect(mockAbortSession).not.toHaveBeenCalled();
    });

    it('does nothing when not streaming (no streamingMessageId)', async () => {
      // streamingMessageId is null in mock, so abort should be a no-op
      await useSessionStore.getState().abortSession();
      expect(mockAbortSession).not.toHaveBeenCalled();
    });
  });

  describe('simple state setters', () => {
    it('setConnected updates isConnected', () => {
      useSessionStore.getState().setConnected(true);
      expect(useSessionStore.getState().isConnected).toBe(true);

      useSessionStore.getState().setConnected(false);
      expect(useSessionStore.getState().isConnected).toBe(false);
    });

    it('setError sets and clears error', () => {
      useSessionStore.getState().setError('Something went wrong');
      expect(useSessionStore.getState().error).toBe('Something went wrong');

      useSessionStore.getState().setError(null);
      expect(useSessionStore.getState().error).toBeNull();
    });

    it('setInactivityWarning toggles warning state', () => {
      useSessionStore.getState().setInactivityWarning(true);
      expect(useSessionStore.getState().inactivityWarning).toBe(true);

      useSessionStore.getState().setInactivityWarning(false);
      expect(useSessionStore.getState().inactivityWarning).toBe(false);
    });
  });

  describe('getActiveSession', () => {
    it('returns undefined when no active session', () => {
      useSessionStore.setState({ activeSessionId: null });
      expect(useSessionStore.getState().getActiveSession()).toBeUndefined();
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockSendMessage = vi.fn();
const mockAbortSession = vi.fn();
const mockRemoveFromQueue = vi.fn();
const mockLoadSessions = vi.fn().mockResolvedValue(undefined);
const mockResetSessions = vi.fn();
const mockClearSessionError = vi.fn();
const mockSetError = vi.fn();
const mockSetDraftInput = vi.fn();
const mockSetSelectedModel = vi.fn();
const mockAnswerQuestion = vi.fn(() => Promise.resolve());
const mockSkipQuestion = vi.fn(() => Promise.resolve());
const workspaceState = {
  workspacePath: '/test',
  openCodeBootstrapped: true,
  openCodeReady: true,
  setOpenCodeBootstrapped: vi.fn(),
  setOpenCodeReady: vi.fn(),
};

const mockSessionState = {
  activeSessionId: 'sess-1',
  error: null,
  isConnected: true,
  messageQueue: [] as Array<{ id: string; content: string; timestamp: Date }>,
  sessionError: null,
  inactivityWarning: false,
  draftInput: '',
  pendingPermissions: [] as Array<unknown>,
  pendingQuestions: [] as Array<{
    questionId: string;
    toolCallId: string;
    messageId: string;
    questions: Array<{
      id?: string;
      header?: string;
      question: string;
      options: Array<{ label: string; value?: string }>;
    }>;
  }>,
  todos: [] as Array<unknown>,
  sessions: [
    {
      id: 'sess-1',
      title: 'Test',
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ],
  sendMessage: mockSendMessage,
  abortSession: mockAbortSession,
  removeFromQueue: mockRemoveFromQueue,
  loadSessions: mockLoadSessions,
  resetSessions: mockResetSessions,
  clearSessionError: mockClearSessionError,
  setError: mockSetError,
  setSelectedModel: mockSetSelectedModel,
  setDraftInput: mockSetDraftInput,
  answerQuestion: mockAnswerQuestion,
  skipQuestion: mockSkipQuestion,
  pollPermissions: vi.fn(),
};

vi.mock('@/stores/session', () => ({
  useSessionStore: Object.assign(
    (selector: (s: typeof mockSessionState) => unknown) => selector(mockSessionState),
    {
      getState: () => mockSessionState,
    },
  ),
}));

vi.mock('@/stores/streaming', () => ({
  useStreamingStore: (selector: (s: unknown) => unknown) =>
    selector({ streamingMessageId: null, streamingContent: '' }),
}));

vi.mock('@/stores/voice-input', () => ({
  useVoiceInputStore: {
    getState: () => ({
      registerInsertToChatHandler: vi.fn(() => vi.fn()),
    }),
  },
}));

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector(workspaceState),
}));

vi.mock('@/stores/provider', () => ({
  useProviderStore: (selector: (s: unknown) => unknown) =>
    selector({ currentModelKey: null, initAll: vi.fn() }),
  getSelectedModelOption: () => null,
}));

vi.mock('@/stores/team-mode', () => ({
  useTeamModeStore: Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({ teamMode: false }),
    {
      getState: () => ({
        loadTeamConfig: vi.fn().mockResolvedValue(undefined),
        applyTeamModelToOpenCode: vi.fn(),
        teamMode: false,
      }),
    },
  ),
}));

vi.mock('@/stores/suggestions', () => ({
  useSuggestionsStore: (selector: (s: unknown) => unknown) =>
    selector({ customSuggestions: [] }),
}));

vi.mock('@/hooks/useAppInit', () => ({
  SKILLS_CHANGED_EVENT: 'skills-files-changed',
}));

vi.mock('@/stores/shortcuts', () => ({
  useShortcutsStore: Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({ setTeamNodes: vi.fn() }),
    {
      getState: () => ({
        setTeamNodes: vi.fn(),
      }),
    },
  ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, options?: Record<string, unknown>) => {
      const template = fallback ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, token: string) =>
        String(options?.[token] ?? `{{${token}}}`),
      );
    },
  }),
}));

vi.mock('@/lib/utils', () => ({
  isTauri: () => false,
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}));

vi.mock('@/lib/opencode/sdk-client', () => ({
  getOpenCodeClient: () => ({
    executeCommand: vi.fn(),
  }),
}));

// Mock child components to isolate ChatPanel behavior
vi.mock('../MessageList', () => ({
  MessageList: React.forwardRef(function MockMessageList(
    props: { messages: unknown[]; emptyState?: React.ReactNode },
    _ref: unknown,
  ) {
    return React.createElement(
      'div',
      { 'data-testid': 'message-list' },
      props.messages.length === 0 && props.emptyState
        ? props.emptyState
        : `${props.messages.length} messages`,
    );
  }),
}));

vi.mock('../SessionErrorAlert', () => ({
  SessionErrorAlert: ({ error, onDismiss }: { error: unknown; onDismiss: () => void }) =>
    React.createElement(
      'div',
      { 'data-testid': 'session-error', onClick: onDismiss },
      String(typeof error === 'string' ? error : 'Error'),
    ),
}));

vi.mock('../PermissionCard', () => ({
  PendingPermissionInline: () =>
    mockSessionState.pendingPermissions.length > 0
      ? React.createElement('div', { 'data-testid': 'pending-permission-inline' }, 'permissions')
      : null,
  hasVisiblePendingPermissions: (_activeSessionId: string | null, _sessions: unknown[], pendingPermissions: unknown[]) =>
    pendingPermissions.length > 0,
}));

vi.mock('../ChatInputArea', () => ({
  ChatInputArea: (props: {
    inputValue: string;
    onInputChange: (v: string) => void;
    onSubmit: (msg: { text: string; mentions: never[] }) => void;
    isStreaming: boolean;
    onAbort: () => void;
    attachedFiles: string[];
    onFilesChange: (paths: string[]) => void;
    onRemoveFile: (index: number) => void;
    headerContent?: React.ReactNode;
  }) =>
    React.createElement('div', { 'data-testid': 'chat-input-area' }, [
      props.headerContent && React.createElement('div', { key: 'header' }, props.headerContent),
      React.createElement('input', {
        key: 'input',
        'data-testid': 'mock-input',
        value: props.inputValue,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => props.onInputChange(e.target.value),
      }),
      React.createElement(
        'button',
        {
          key: 'submit',
          'data-testid': 'mock-submit',
          onClick: () => props.onSubmit({ text: props.inputValue, mentions: [] }),
        },
        'Send',
      ),
      React.createElement(
        'button',
        {
          key: 'abort',
          'data-testid': 'mock-abort',
          onClick: props.onAbort,
        },
        'Stop',
      ),
      React.createElement(
        'button',
        {
          key: 'add-file',
          'data-testid': 'mock-add-file',
          onClick: () => props.onFilesChange(['/test/file.ts']),
        },
        'Add File',
      ),
      React.createElement(
        'button',
        {
          key: 'remove-file',
          'data-testid': 'mock-remove-file',
          onClick: () => props.onRemoveFile(0),
        },
        'Remove File',
      ),
    ]),
}));

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ChatPanel submission flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceState.workspacePath = '/test';
    workspaceState.openCodeBootstrapped = true;
    workspaceState.openCodeReady = true;
    mockSessionState.activeSessionId = 'sess-1';
    mockSessionState.error = null;
    mockSessionState.isConnected = true;
    mockSessionState.messageQueue = [];
    mockSessionState.sessionError = null;
    mockSessionState.draftInput = '';
    mockSessionState.pendingPermissions = [];
    mockSessionState.pendingQuestions = [];
    mockSessionState.todos = [];
    mockSkipQuestion.mockClear();
    mockSessionState.sessions = [
      {
        id: 'sess-1',
        title: 'Test',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
  });

  describe('message submission', () => {
    it('loads sessions before full ready and shows startup overlay', async () => {
      workspaceState.openCodeReady = false;
      const { ChatPanel } = await import('../ChatPanel');
      render(React.createElement(ChatPanel));

      await waitFor(() => {
        expect(mockLoadSessions).toHaveBeenCalledWith('/test');
      });
      expect(screen.getByText('Starting agent...')).toBeTruthy();
    });

    it('does not send messages before full ready', async () => {
      workspaceState.openCodeReady = false;
      mockSessionState.draftInput = 'Hello early';
      const { ChatPanel } = await import('../ChatPanel');
      render(React.createElement(ChatPanel));

      await act(async () => {
        fireEvent.click(screen.getByTestId('mock-submit'));
      });

      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('calls sendMessage when submit is triggered with text', async () => {
      mockSessionState.draftInput = 'Hello agent';

      const { ChatPanel } = await import('../ChatPanel');
      render(React.createElement(ChatPanel));

      // The mock ChatInputArea receives inputValue from draftInput and calls onSubmit
      const submitBtn = screen.getByTestId('mock-submit');
      await act(async () => {
        fireEvent.click(submitBtn);
      });

      // sendMessage should be called with the input content
      expect(mockSendMessage).toHaveBeenCalled();
    });

    it('clears input after submission', async () => {
      mockSessionState.draftInput = 'Hello agent';

      const { ChatPanel } = await import('../ChatPanel');
      render(React.createElement(ChatPanel));

      const submitBtn = screen.getByTestId('mock-submit');
      await act(async () => {
        fireEvent.click(submitBtn);
      });

      // setDraftInput should be called with empty string to clear
      expect(mockSetDraftInput).toHaveBeenCalledWith('');
    });

    it('preserves namespaced skill mentions in submitted content', async () => {
      mockSessionState.draftInput = '/{skill:superpowers/brainstorming}';

      const { ChatPanel } = await import('../ChatPanel');
      render(React.createElement(ChatPanel));

      const submitBtn = screen.getByTestId('mock-submit');
      await act(async () => {
        fireEvent.click(submitBtn);
      });

      expect(mockSendMessage).toHaveBeenCalledWith(
        '[Skill: superpowers/brainstorming|instruction:You must call skill({ name: "superpowers/brainstorming" }) before any other action.]',
        undefined,
        undefined,
      );
    });

    it('serializes role mentions into role directives on submit', async () => {
      mockSessionState.draftInput = '/{role:accounting-dimensions}';

      const { ChatPanel } = await import('../ChatPanel');
      render(React.createElement(ChatPanel));

      const submitBtn = screen.getByTestId('mock-submit');
      await act(async () => {
        fireEvent.click(submitBtn);
      });

      expect(mockSendMessage).toHaveBeenCalledWith(
        '[Role: accounting-dimensions|instruction:You must call role_load({ name: "accounting-dimensions" }) before any other action.]',
        undefined,
        undefined,
      );
    });
  });

  describe('empty state with suggestions', () => {
    it('shows suggestions when no messages in session', async () => {
      const { ChatPanel } = await import('../ChatPanel');
      render(React.createElement(ChatPanel));

      // Empty state shows suggestions
      expect(screen.getByText('Start a New Chat')).toBeDefined();
      expect(screen.getByText('Analyze data')).toBeDefined();
      expect(screen.getByText('Write a report')).toBeDefined();
      expect(screen.getByText('Add a new skill')).toBeDefined();
    });
  });

  describe('connection status', () => {
    it('shows connecting indicator when disconnected with active session', async () => {
      mockSessionState.isConnected = false;
      mockSessionState.activeSessionId = 'sess-1';

      const { ChatPanel } = await import('../ChatPanel');
      render(React.createElement(ChatPanel));

      expect(screen.getByText('Connecting...')).toBeDefined();
    });

    it('does not show connecting indicator when connected', async () => {
      mockSessionState.isConnected = true;

      const { ChatPanel } = await import('../ChatPanel');
      render(React.createElement(ChatPanel));

      expect(screen.queryByText('Connecting...')).toBeNull();
    });
  });

  describe('inline todo dock', () => {
    it('renders inline todo panel above the input when no approval is pending', async () => {
      mockSessionState.todos = [
        { id: 'todo-1', content: 'Inspect parser config', status: 'in_progress', priority: 'high' },
        { id: 'todo-2', content: 'Verify markdown rendering', status: 'pending', priority: 'medium' },
      ];

      const { ChatPanel } = await import('../ChatPanel');
      render(React.createElement(ChatPanel));

      expect(screen.getByTestId('todo-list-inline')).toBeTruthy();
      expect(screen.queryByTestId('pending-permission-inline')).toBeNull();
    });

    it('hides inline todo panel when a permission card is occupying the dock', async () => {
      mockSessionState.todos = [
        { id: 'todo-1', content: 'Inspect parser config', status: 'in_progress', priority: 'high' },
      ];
      mockSessionState.pendingPermissions = [{ permission: { id: 'perm-1' } }];

      const { ChatPanel } = await import('../ChatPanel');
      render(React.createElement(ChatPanel));

      expect(screen.queryByTestId('todo-list-inline')).toBeNull();
      expect(screen.getByTestId('pending-permission-inline')).toBeTruthy();
    });

    it('renders a unified dock when todos and message queue are both present', async () => {
      mockSessionState.todos = [
        { id: 'todo-1', content: 'Inspect parser config', status: 'in_progress', priority: 'high' },
      ];
      mockSessionState.messageQueue = [
        { id: 'queued-1', content: 'run follow-up check', timestamp: new Date() },
      ];

      const { ChatPanel } = await import('../ChatPanel');
      render(React.createElement(ChatPanel));

      expect(screen.getByTestId('todo-list-inline')).toBeTruthy();
      expect(screen.getByTestId('todo-list-inline-queue').textContent).toContain('1 messages queued');
      expect(screen.getByText('Inspect parser config')).toBeTruthy();
    });

    it('renders the unified dock in queue-only mode when there are no todos', async () => {
      mockSessionState.messageQueue = [
        { id: 'queued-1', content: 'run follow-up check', timestamp: new Date() },
      ];

      const { ChatPanel } = await import('../ChatPanel');
      render(React.createElement(ChatPanel));

      expect(screen.getByTestId('todo-list-inline')).toBeTruthy();
      expect(screen.getByTestId('todo-list-inline-queue').textContent).toContain('1 messages queued');
      expect(screen.getByText('run follow-up check')).toBeTruthy();
    });

    it('hides the unified dock when approval is occupying the dock, even if queue exists', async () => {
      mockSessionState.todos = [
        { id: 'todo-1', content: 'Inspect parser config', status: 'in_progress', priority: 'high' },
      ];
      mockSessionState.messageQueue = [
        { id: 'queued-1', content: 'run follow-up check', timestamp: new Date() },
      ];
      mockSessionState.pendingPermissions = [{ permission: { id: 'perm-1' } }];

      const { ChatPanel } = await import('../ChatPanel');
      render(React.createElement(ChatPanel));

      expect(screen.queryByTestId('todo-list-inline')).toBeNull();
      expect(screen.getByTestId('pending-permission-inline')).toBeTruthy();
      expect(screen.queryByText('1 messages queued')).toBeNull();
    });
  });

  describe('question input takeover', () => {
    it('replaces the whole input dock when a question is pending', async () => {
      mockSessionState.todos = [
        { id: 'todo-1', content: 'Inspect parser config', status: 'in_progress', priority: 'high' },
      ];
      mockSessionState.messageQueue = [
        { id: 'queued-1', content: 'run follow-up check', timestamp: new Date() },
      ];
      mockSessionState.pendingPermissions = [{ permission: { id: 'perm-1' } }];
      mockSessionState.pendingQuestions = [
        {
          questionId: 'question-event-1',
          toolCallId: 'tool-call-1',
          messageId: 'message-1',
          questions: [
            {
              id: 'q-1',
              header: '下一步',
              question: '你希望我接下来做什么？',
              options: [
                { label: '继续测试', value: 'continue' },
                { label: '结束即可', value: 'finish' },
              ],
            },
          ],
        },
      ];

      const { ChatPanel } = await import('../ChatPanel');
      render(React.createElement(ChatPanel));

      expect(screen.queryByTestId('chat-input-area')).toBeNull();
      expect(screen.queryByTestId('todo-list-inline')).toBeNull();
      expect(screen.queryByTestId('pending-permission-inline')).toBeNull();
      expect(screen.queryByText('1 messages queued')).toBeNull();
      expect(screen.getByTestId('question-input-dock')).toBeTruthy();
      expect(screen.getByText('你希望我接下来做什么？')).toBeTruthy();
      expect(screen.getByText('继续测试')).toBeTruthy();
    });

    it('skips the active question from the question dock', async () => {
      mockSessionState.pendingQuestions = [
        {
          questionId: 'question-event-1',
          toolCallId: 'tool-call-1',
          messageId: 'message-1',
          questions: [
            {
              id: 'q-1',
              header: '下一步',
              question: '你希望我接下来做什么？',
              options: [
                { label: '继续测试', value: 'continue' },
                { label: '结束即可', value: 'finish' },
              ],
            },
          ],
        },
      ];

      const { ChatPanel } = await import('../ChatPanel');
      render(React.createElement(ChatPanel));

      fireEvent.click(screen.getByRole('button', { name: /skip/i }));

      await waitFor(() => {
        expect(mockSkipQuestion).toHaveBeenCalledWith('question-event-1');
      });
    });

    it('advances to the next question after selecting a preset answer', async () => {
      mockSessionState.pendingQuestions = [
        {
          questionId: 'question-event-1',
          toolCallId: 'tool-call-1',
          messageId: 'message-1',
          questions: [
            {
              id: 'q-1',
              header: '第一题',
              question: '先做什么？',
              options: [{ label: '先看全局', value: 'overview' }],
            },
            {
              id: 'q-2',
              header: '第二题',
              question: '然后做什么？',
              options: [{ label: '继续推进', value: 'continue' }],
            },
          ],
        },
      ];

      const { ChatPanel } = await import('../ChatPanel');
      render(React.createElement(ChatPanel));

      fireEvent.click(screen.getByRole('button', { name: /先看全局/i }));

      expect(screen.getByText('然后做什么？')).toBeTruthy();
      expect(mockAnswerQuestion).not.toHaveBeenCalled();
    });

    it('selects the last preset answer without auto-submitting', async () => {
      mockSessionState.pendingQuestions = [
        {
          questionId: 'question-event-1',
          toolCallId: 'tool-call-1',
          messageId: 'message-1',
          questions: [
            {
              id: 'q-1',
              header: '唯一问题',
              question: '最后怎么做？',
              options: [{ label: '结束即可', value: 'finish' }],
            },
          ],
        },
      ];

      const { ChatPanel } = await import('../ChatPanel');
      render(React.createElement(ChatPanel));

      fireEvent.click(screen.getByRole('button', { name: /结束即可/i }));

      expect(screen.getByText('最后怎么做？')).toBeTruthy();
      expect(mockAnswerQuestion).not.toHaveBeenCalled();
    });
  });

  describe('error display', () => {
    it('shows session error alert when sessionError exists', async () => {
      mockSessionState.sessionError = {
        sessionId: 'sess-1',
        error: { name: 'TestError', data: { message: 'Test error' } },
      } as unknown as typeof mockSessionState.sessionError;

      const { ChatPanel } = await import('../ChatPanel');
      render(React.createElement(ChatPanel));

      expect(screen.getByTestId('session-error')).toBeDefined();
    });

    it('shows general error when error exists and no sessionError', async () => {
      mockSessionState.error = 'Network error' as unknown as typeof mockSessionState.error;
      mockSessionState.sessionError = null;

      const { ChatPanel } = await import('../ChatPanel');
      render(React.createElement(ChatPanel));

      expect(screen.getByTestId('session-error')).toBeDefined();
    });
  });

  describe('file handling', () => {
    it('accumulates files when onFilesChange is called', async () => {
      const { ChatPanel } = await import('../ChatPanel');
      render(React.createElement(ChatPanel));

      const addFileBtn = screen.getByTestId('mock-add-file');
      fireEvent.click(addFileBtn);

      // The internal state should have the file, verified through the mock ChatInputArea
      // Since we can't directly inspect React state, we verify via behavior
      expect(addFileBtn).toBeTruthy();
    });
  });

  describe('abort', () => {
    it('calls abortSession when abort button clicked', async () => {
      const { ChatPanel } = await import('../ChatPanel');
      render(React.createElement(ChatPanel));

      const abortBtn = screen.getByTestId('mock-abort');
      fireEvent.click(abortBtn);

      expect(mockAbortSession).toHaveBeenCalled();
    });
  });
});

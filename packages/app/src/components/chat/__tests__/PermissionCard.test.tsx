import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ── Mocks ──────────────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, options?: Record<string, unknown>) => {
      const template = fallback ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, token: string) => String(options?.[token] ?? `{{${token}}}`));
    },
  }),
}));

// Session store state — mutated per test
const sessionState = {
  activeSessionId: null as string | null,
  sessions: [] as Array<{
    id: string;
    parentID?: string;
    messages: Array<{
      toolCalls?: Array<{
        id: string;
        name?: string;
        status: string;
        permission?: {
          id: string;
          sessionID?: string;
          permission: string;
          patterns: string[];
          metadata?: Record<string, string>;
          decision: string;
        };
      }>;
    }>;
  }>,
  pendingPermissions: [] as Array<{
    permission: {
      id: string;
      sessionID?: string;
      permission: string;
      patterns: string[];
      metadata?: Record<string, string>;
    };
    childSessionId: string | null;
    ownerSessionId?: string | null;
  }>,
  replyPermission: vi.fn(() => Promise.resolve()),
};

vi.mock('@/stores/session', () => ({
  useSessionStore: (selector: (s: typeof sessionState) => unknown) =>
    selector(sessionState),
}));

// Streaming store state — mutated per test
const streamingState = {
  childSessionStreaming: {} as Record<string, { sessionId: string; text: string; reasoning: string; isStreaming: boolean }>,
};

vi.mock('@/stores/streaming', () => ({
  useStreamingStore: (selector: (s: typeof streamingState) => unknown) =>
    selector(streamingState),
}));

// ── Tests ──────────────────────────────────────────────────────────────

describe('PendingPermissionInline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.activeSessionId = null;
    sessionState.sessions = [];
    sessionState.pendingPermissions = [];
    sessionState.replyPermission = vi.fn(() => Promise.resolve());
    streamingState.childSessionStreaming = {};
  });

  it('renders permission request details', async () => {
    sessionState.pendingPermissions = [
      {
        permission: {
          id: 'perm-1',
          permission: 'bash',
          patterns: ['ls -la'],
        },
        childSessionId: 'child-sess-1',
      },
    ];
    streamingState.childSessionStreaming = {
      'child-sess-1': {
        sessionId: 'child-sess-1',
        text: 'some output',
        reasoning: '',
        isStreaming: true,
      },
    };

    const { PendingPermissionInline } = await import('../PermissionCard');

    render(<PendingPermissionInline />);

    const overlay = screen.getByTestId('pending-permission-inline');
    expect(overlay.className).toContain('justify-center');
    expect(overlay.className).toContain('w-[min(92vw,48rem)]');

    const card = screen.getByTestId('pending-permission-card');
    expect(card.className).toContain('slide-in-from-bottom-4');
    expect(card.className).toContain('rounded-[16px]');
    expect(card.className).toContain('border');
    expect(card.className).not.toContain('shadow-');

    const actions = screen.getByTestId('pending-permission-actions');
    expect(actions.className).toContain('gap-2');

    expect(screen.getByText('Bash Request command execution')).toBeTruthy();
    expect(screen.getByText('ls -la')).toBeTruthy();
    expect(screen.getByText('允许')).toBeTruthy();
    expect(screen.getByText('拒绝')).toBeTruthy();
  });

  it('summarizes long bash command details to avoid squeezing the UI', async () => {
    const longCommand = "ps -axo pid,ppid,stat,command rg '[[:<:]]8082[[:>:]]' printf 'no ps-visible process args mention 8082\\n'"
    sessionState.pendingPermissions = [
      {
        permission: {
          id: 'perm-long-bash',
          permission: 'bash',
          patterns: [longCommand],
        },
        childSessionId: 'child-sess-long',
      },
    ];

    const { PendingPermissionInline } = await import('../PermissionCard');
    render(<PendingPermissionInline />);

    expect(screen.getByText(/ps -axo pid,ppid,stat,command/)).toBeTruthy();
    expect(screen.getByText((text) => text.includes(' ... '))).toBeTruthy();
    expect(screen.queryByText(longCommand)).toBeNull();
  });

  it('clicking allow calls replyPermission with correct arguments', async () => {
    const replyMock = vi.fn(() => Promise.resolve());
    sessionState.replyPermission = replyMock;
    sessionState.pendingPermissions = [
      {
        permission: {
          id: 'perm-1',
          permission: 'bash',
          patterns: ['ls -la'],
        },
        childSessionId: 'child-sess-1',
      },
    ];
    streamingState.childSessionStreaming = {
      'child-sess-1': {
        sessionId: 'child-sess-1',
        text: 'some output',
        reasoning: '',
        isStreaming: true,
      },
    };

    const { PendingPermissionInline } = await import('../PermissionCard');

    render(<PendingPermissionInline />);

    const allowButton = screen.getByText('允许').closest('button');
    expect(allowButton).not.toBeNull();
    fireEvent.click(allowButton!);

    await waitFor(() => {
      expect(replyMock).toHaveBeenCalledWith('perm-1', 'allow');
    });
  });

  it('promotes the next queued permission immediately before reply resolves', async () => {
    let resolveReply: (() => void) | null = null;
    const replyMock = vi.fn(() => new Promise<void>((resolve) => {
      resolveReply = resolve;
    }));
    sessionState.replyPermission = replyMock;
    sessionState.pendingPermissions = [
      {
        permission: {
          id: 'perm-1',
          permission: 'bash',
          patterns: ['first-command'],
        },
        childSessionId: 'child-sess-1',
      },
      {
        permission: {
          id: 'perm-2',
          permission: 'read',
          patterns: ['second-path'],
        },
        childSessionId: 'child-sess-2',
      },
    ];

    const { PendingPermissionInline } = await import('../PermissionCard');
    render(<PendingPermissionInline />);

    expect(screen.getByText('first-command')).toBeTruthy();
    fireEvent.click(screen.getByText('允许'));

    await waitFor(() => {
      expect(screen.queryByText('first-command')).toBeNull();
      expect(screen.getByText('second-path')).toBeTruthy();
    });

    resolveReply?.();
    await waitFor(() => {
      expect(replyMock).toHaveBeenCalledWith('perm-1', 'allow');
    });
  });

  it('renders unified action group for skill permissions without command or file details', async () => {
    sessionState.pendingPermissions = [
      {
        permission: {
          id: 'perm-skill-1',
          permission: 'skill',
          patterns: [],
          metadata: {
            skill: 'brainstorming',
          },
        },
        childSessionId: 'child-sess-2',
      },
    ];

    const { PendingPermissionInline } = await import('../PermissionCard');

    render(<PendingPermissionInline />);

    expect(screen.getByText('Skill Request skill run')).toBeTruthy();
    expect(screen.getByText('允许')).toBeTruthy();
    expect(screen.getByText('总是允许')).toBeTruthy();
    expect(screen.getByText('拒绝')).toBeTruthy();
    expect(screen.getByText('brainstorming')).toBeTruthy();
  });

  it('renders only the oldest child permission card with queued count and stacked backplates', async () => {
    sessionState.pendingPermissions = [
      {
        permission: {
          id: 'perm-1',
          permission: 'bash',
          patterns: ['first-command'],
        },
        childSessionId: 'child-sess-1',
      },
      {
        permission: {
          id: 'perm-2',
          permission: 'skill',
          patterns: [],
          metadata: {
            skill: 'second-skill',
          },
        },
        childSessionId: 'child-sess-2',
      },
      {
        permission: {
          id: 'perm-3',
          permission: 'read',
          patterns: ['third-path'],
        },
        childSessionId: 'child-sess-3',
      },
    ];

    const { PendingPermissionInline } = await import('../PermissionCard');

    render(<PendingPermissionInline />);

    expect(screen.getByText('first-command')).toBeTruthy();
    expect(screen.getByText('second-skill')).toBeTruthy();
    expect(screen.getByText('third-path')).toBeTruthy();
    expect(screen.getByText('3 pending')).toBeTruthy();
    const backplates = screen.getAllByTestId('pending-permission-backplate');
    expect(backplates).toHaveLength(2);
    expect(backplates[0].getAttribute('style')).toContain('bottom: 24px');
    expect(backplates[1].getAttribute('style')).toContain('bottom: 12px');
    expect(screen.getByTestId('pending-permission-current').className).toContain('bottom-0');
    expect(backplates[0].getAttribute('style')).toContain('42.25rem');
    expect(backplates[1].getAttribute('style')).toContain('40rem');
    expect(screen.getByTestId('pending-permission-actions')).toBeTruthy();
  });

  it('does not render a global pending permission owned by a different active session', async () => {
    sessionState.activeSessionId = 'session-2';
    sessionState.sessions = [
      { id: 'session-1', messages: [] },
      { id: 'session-2', messages: [] },
    ];
    sessionState.pendingPermissions = [
      {
        permission: {
          id: 'perm-session-1',
          sessionID: 'child-session-1',
          permission: 'bash',
          patterns: ['belongs-to-session-1'],
        },
        childSessionId: 'child-session-1',
        ownerSessionId: 'session-1',
      },
    ];

    const { PendingPermissionInline } = await import('../PermissionCard');

    render(<PendingPermissionInline />);

    expect(screen.queryByTestId('pending-permission-inline')).toBeNull();
    expect(screen.queryByText('belongs-to-session-1')).toBeNull();
  });

  it('renders a child-session global pending permission for its owning active session', async () => {
    sessionState.activeSessionId = 'parent-1';
    sessionState.sessions = [
      { id: 'parent-1', messages: [] },
    ];
    sessionState.pendingPermissions = [
      {
        permission: {
          id: 'perm-child-owned',
          sessionID: 'child-session-owned',
          permission: 'bash',
          patterns: ['child-owned-command'],
        },
        childSessionId: 'child-session-owned',
        ownerSessionId: 'parent-1',
      },
    ];

    const { PendingPermissionInline } = await import('../PermissionCard');

    render(<PendingPermissionInline />);

    expect(screen.getByText('child-owned-command')).toBeTruthy();
    expect(screen.getByText('子会话正在等待你的审批')).toBeTruthy();
  });

  it('uses the same stacked approval UI for tool-attached and child-session permissions together', async () => {
    sessionState.activeSessionId = 'session-1';
    sessionState.sessions = [
      {
        id: 'session-1',
        messages: [
          {
            toolCalls: [
              {
                id: 'tool-1',
                name: 'bash',
                status: 'waiting',
                permission: {
                  id: 'perm-tool-1',
                  permission: 'external_directory',
                  patterns: ['/tmp/outside'],
                  metadata: {
                    file: '/tmp/outside',
                  },
                  decision: 'pending',
                },
              },
            ],
          },
        ],
      },
    ];
    sessionState.pendingPermissions = [
      {
        permission: {
          id: 'perm-child-1',
          permission: 'skill',
          patterns: [],
          metadata: {
            skill: 'brainstorming',
          },
        },
        childSessionId: 'child-sess-1',
        ownerSessionId: 'session-1',
      },
    ];

    const { PendingPermissionInline } = await import('../PermissionCard');

    render(<PendingPermissionInline />);

    expect(screen.getByText('Bash Request external path access')).toBeTruthy();
    expect(screen.getByText('brainstorming')).toBeTruthy();
    expect(screen.getByText('来自 Bash 工具调用')).toBeTruthy();
    expect(screen.getByText('子会话正在等待你的审批')).toBeTruthy();
    expect(screen.getAllByTestId('pending-permission-backplate')).toHaveLength(1);
  });

  it('renders child-session permissions even when child streaming state is already gone', async () => {
    sessionState.pendingPermissions = [
      {
        permission: {
          id: 'perm-edit-1',
          permission: 'edit',
          patterns: ['notes.md'],
          metadata: {
            file: '/workspace/notes.md',
          },
        },
        childSessionId: 'child-sess-edit',
      },
    ];
    streamingState.childSessionStreaming = {};

    const { PendingPermissionInline } = await import('../PermissionCard');

    render(<PendingPermissionInline />);

    expect(screen.getByText('Edit Request file edit')).toBeTruthy();
    expect(screen.getByText('/workspace/notes.md')).toBeTruthy();
    expect(screen.getByText('允许')).toBeTruthy();
  });

  it('renders tool-attached permissions from the active session above the input', async () => {
    sessionState.activeSessionId = 'session-1';
    sessionState.sessions = [
      {
        id: 'session-1',
        messages: [
          {
            toolCalls: [
              {
                id: 'tool-1',
                status: 'waiting',
                permission: {
                  id: 'perm-tool-1',
                  permission: 'bash',
                  patterns: ['pnpm test'],
                  decision: 'pending',
                },
              },
            ],
          },
        ],
      },
    ];

    const { PendingPermissionInline } = await import('../PermissionCard');

    render(<PendingPermissionInline />);

    expect(screen.getByText('Bash Request command execution')).toBeTruthy();
    expect(screen.getByText('pnpm test')).toBeTruthy();
    expect(screen.getByText('工具调用正在等待你的审批')).toBeTruthy();
  });

  it('uses the source tool context for external directory approvals', async () => {
    sessionState.activeSessionId = 'session-1';
    sessionState.sessions = [
      {
        id: 'session-1',
        messages: [
          {
            toolCalls: [
              {
                id: 'tool-bash-1',
                name: 'bash',
                status: 'waiting',
                permission: {
                  id: 'perm-tool-external-1',
                  permission: 'external_directory',
                  patterns: ['/tmp/outside'],
                  metadata: {
                    file: '/tmp/outside',
                  },
                  decision: 'pending',
                },
              },
            ],
          },
        ],
      },
    ];

    const { PendingPermissionInline } = await import('../PermissionCard');

    render(<PendingPermissionInline />);

    expect(screen.getByText('Bash Request external path access')).toBeTruthy();
    expect(screen.getByText('/tmp/outside')).toBeTruthy();
    expect(screen.getByText('来自 Bash 工具调用')).toBeTruthy();
  });
});

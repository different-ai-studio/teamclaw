import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ── Mocks ──────────────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

// Session store state — mutated per test
const sessionState = {
  pendingPermissions: [] as Array<{
    permission: {
      id: string;
      permission: string;
      patterns: string[];
      metadata?: Record<string, string>;
    };
    childSessionId: string | null;
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
    expect(overlay.className).toContain('w-[min(92vw,40rem)]');

    const card = screen.getByTestId('pending-permission-card');
    expect(card.className).toContain('slide-in-from-bottom-4');
    expect(card.className).toContain('rounded-t-[18px]');
    expect(card.className).toContain('rounded-b-none');
    expect(card.className).not.toContain('shadow-');
    expect(card.className).not.toContain('border ');

    const tail = screen.getByTestId('pending-permission-tail');
    expect(tail.className).toContain('bg-card');
    expect(tail.className).toContain('h-16');

    const actions = screen.getByTestId('pending-permission-actions');
    expect(actions.className).toContain('rounded-xl');

    // Should show the command text from patterns
    expect(screen.getByText('ls -la')).toBeTruthy();
    // Should show the allow button
    expect(screen.getByText('Allow')).toBeTruthy();
    // Should show the deny button
    expect(screen.getByText('Deny')).toBeTruthy();
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

    const allowButton = screen.getByText('Allow').closest('button');
    expect(allowButton).not.toBeNull();
    fireEvent.click(allowButton!);

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

    expect(screen.getByText('Run skill')).toBeTruthy();
    expect(screen.getByText('Allow')).toBeTruthy();
    expect(screen.getByText('Always allow')).toBeTruthy();
    expect(screen.getByText('Deny')).toBeTruthy();
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
    expect(screen.queryByText('second-skill')).toBeNull();
    expect(screen.queryByText('third-path')).toBeNull();
    expect(screen.getByText('3 pending')).toBeTruthy();
    expect(screen.getAllByTestId('pending-permission-backplate')).toHaveLength(2);
  });
});

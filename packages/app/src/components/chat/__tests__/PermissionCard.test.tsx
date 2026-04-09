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
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { useSessionStore } from '@/stores/session';
import { useStreamingStore } from '@/stores/streaming';
import { MessageList } from '../MessageList';
import type { Message } from '@/stores/session';

// ── Mocks ──────────────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('@/lib/i18n', () => ({
  default: { t: (key: string) => key },
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// ── Helpers ────────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg-${Math.random()}`,
    sessionId: 'sess-1',
    role: 'user',
    content: 'test content',
    parts: [],
    toolCalls: [],
    isStreaming: false,
    timestamp: new Date(),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('MessageList', () => {
  beforeEach(() => {
    useStreamingStore.setState({
      streamingMessageId: null,
      streamingContent: '',
      streamingUpdateTrigger: 0,
      childSessionStreaming: {},
    });
    useSessionStore.setState({
      isLoading: false,
      messageQueue: [],
      activeSessionId: 'sess-1',
      sessions: [],
    });
  });

  it('messages render in order', () => {
    const msg1 = makeMessage({
      id: 'msg-1',
      role: 'user',
      content: 'First message',
      timestamp: new Date('2024-01-01T10:00:00Z'),
    });
    const msg2 = makeMessage({
      id: 'msg-2',
      role: 'assistant',
      content: 'Second message',
      timestamp: new Date('2024-01-01T10:01:00Z'),
    });

    const { container } = render(
      <MessageList
        messages={[msg2, msg1]} // Passed out of order intentionally
        activeSessionId="sess-1"
        isStreaming={false}
        streamingMessageId={null}
      />
    );

    const text = container.textContent || '';
    const firstIdx = text.indexOf('First message');
    const secondIdx = text.indexOf('Second message');
    // First message should appear before second message in the rendered output
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThanOrEqual(0);
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  it('empty state renders when passed as emptyState prop with no messages', () => {
    const emptyStateNode = <div data-testid="custom-empty">No messages yet</div>;

    const { getByTestId } = render(
      <MessageList
        messages={[]}
        activeSessionId="sess-1"
        isStreaming={false}
        streamingMessageId={null}
        emptyState={emptyStateNode}
      />
    );

    expect(getByTestId('custom-empty')).toBeTruthy();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

globalThis.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn(),
}))

import { fireEvent, render, screen } from '@testing-library/react';
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

  it('renders only the latest 80 messages initially and loads older messages on demand', () => {
    const messages = Array.from({ length: 140 }, (_, index) =>
      makeMessage({
        id: `msg-${index.toString().padStart(3, '0')}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${index}`,
        timestamp: new Date(2024, 0, 1, 0, index),
      }),
    );

    const { container } = render(
      <MessageList
        messages={messages}
        activeSessionId="sess-1"
        isStreaming={false}
        streamingMessageId={null}
      />,
    );

    expect(container.textContent).not.toContain('Message 0');
    expect(container.textContent).toContain('Message 60');
    expect(screen.getByText('Load 60 earlier messages')).toBeTruthy();

    fireEvent.click(screen.getByText('Load 60 earlier messages'));

    expect(container.textContent).toContain('Message 0');
  });

  it('keeps completed assistant token usage visible while a pending assistant is streaming', () => {
    const completedAssistant = makeMessage({
      id: 'assistant-complete',
      role: 'assistant',
      content: 'Done',
      timestamp: new Date('2024-01-01T10:00:00Z'),
      tokens: {
        input: 2500,
        output: 33,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    });
    const pendingAssistant = makeMessage({
      id: 'pending-assistant',
      role: 'assistant',
      content: '',
      timestamp: new Date('2024-01-01T10:01:00Z'),
      isStreaming: true,
    });

    const { container } = render(
      <MessageList
        messages={[completedAssistant, pendingAssistant]}
        activeSessionId="sess-1"
        isStreaming={true}
        streamingMessageId="pending-assistant"
      />,
    );

    expect(container.textContent).toContain('↓2.5k');
    expect(container.textContent).toContain('↑33');
    expect(container.textContent).toContain('tokens');
  });
});

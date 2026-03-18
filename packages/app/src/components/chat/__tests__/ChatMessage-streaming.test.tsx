import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useStreamingStore } from '@/stores/streaming';
import { useSessionStore, sessionLookupCache } from '@/stores/session';

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

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    sessionId: 'sess-1',
    role: 'assistant' as const,
    content: '',
    parts: [] as { id: string; type: string; text?: string; content?: string }[],
    toolCalls: [],
    isStreaming: false,
    timestamp: new Date(),
    ...overrides,
  };
}

function setupStreamingState(content: string, trigger = 0) {
  useStreamingStore.setState({
    streamingMessageId: 'msg-1',
    streamingContent: content,
    streamingUpdateTrigger: trigger,
  });
}

/** Put a session with the given message into the lookup cache so
 *  getSessionById() returns it during streaming. */
function seedCache(message: ReturnType<typeof makeMessage>) {
  sessionLookupCache.set('sess-1', {
    id: 'sess-1',
    messages: [message],
    updatedAt: new Date(),
  } as never);
  useSessionStore.setState({ activeSessionId: 'sess-1' });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('ChatMessage streaming typewriter', () => {
  beforeEach(() => {
    useStreamingStore.setState({
      streamingMessageId: null,
      streamingContent: '',
      streamingUpdateTrigger: 0,
      childSessionStreaming: {},
    });
    sessionLookupCache.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function importChatMessage() {
    const mod = await import('../ChatMessage');
    return mod.ChatMessage;
  }

  it('displays streamingContent from streaming store during active streaming', async () => {
    const ChatMessage = await importChatMessage();

    const message = makeMessage({ isStreaming: true, content: '' });
    seedCache({ ...message, content: 'Hello, wor' });
    setupStreamingState('Hello, wor');

    const { container } = render(<ChatMessage message={message} />);

    expect(container.textContent).toContain('Hello, wor');
  });

  it('updates displayed text as streamingContent grows (typewriter effect)', async () => {
    const ChatMessage = await importChatMessage();

    const message = makeMessage({ isStreaming: true, content: '' });
    seedCache({ ...message, content: 'He' });
    setupStreamingState('He', 1);

    const { container, rerender } = render(<ChatMessage message={message} />);
    expect(container.textContent).toContain('He');

    // Simulate typewriterTick adding more characters
    act(() => {
      const updated = { ...message, content: 'Hello' };
      sessionLookupCache.set('sess-1', { id: 'sess-1', messages: [updated], updatedAt: new Date() } as never);
      useStreamingStore.setState({ streamingContent: 'Hello', streamingUpdateTrigger: 2 });
    });

    rerender(<ChatMessage message={message} />);
    expect(container.textContent).toContain('Hello');

    // More characters
    act(() => {
      const updated = { ...message, content: 'Hello, world!' };
      sessionLookupCache.set('sess-1', { id: 'sess-1', messages: [updated], updatedAt: new Date() } as never);
      useStreamingStore.setState({ streamingContent: 'Hello, world!', streamingUpdateTrigger: 3 });
    });

    rerender(<ChatMessage message={message} />);
    expect(container.textContent).toContain('Hello, world!');
  });

  it('falls back to message.content when not the streaming message', async () => {
    const ChatMessage = await importChatMessage();

    // A different message is streaming
    useStreamingStore.setState({
      streamingMessageId: 'msg-other',
      streamingContent: 'other content',
      streamingUpdateTrigger: 1,
    });

    const message = makeMessage({
      id: 'msg-1',
      isStreaming: false,
      content: 'Final content from store',
    });

    const { container } = render(<ChatMessage message={message} />);

    expect(container.textContent).toContain('Final content from store');
    expect(container.textContent).not.toContain('other content');
  });

  it('falls back to message.content after streaming completes', async () => {
    const ChatMessage = await importChatMessage();

    const message = makeMessage({ isStreaming: true, content: '' });
    seedCache({ ...message, content: 'Partial...' });
    setupStreamingState('Partial...', 1);

    const { container, rerender } = render(<ChatMessage message={message} />);
    expect(container.textContent).toContain('Partial...');

    // Streaming completes
    act(() => {
      useStreamingStore.setState({
        streamingMessageId: null,
        streamingContent: '',
        streamingUpdateTrigger: 0,
      });
    });

    const completedMessage = makeMessage({
      isStreaming: false,
      content: 'Full final response text',
    });

    rerender(<ChatMessage message={completedMessage} />);

    expect(container.textContent).toContain('Full final response text');
    expect(container.textContent).not.toContain('Partial...');
  });

  it('shows bouncing dots indicator during streaming when text exists', async () => {
    const ChatMessage = await importChatMessage();

    const message = makeMessage({ isStreaming: true, content: '' });
    seedCache({ ...message, content: 'Some text' });
    setupStreamingState('Some text', 1);

    const { container } = render(<ChatMessage message={message} />);

    // The bouncing dots are rendered as 3 spans with animate-[bounce...] class
    const dots = container.querySelectorAll('[class*="animate-"]');
    expect(dots.length).toBeGreaterThanOrEqual(3);
  });
});

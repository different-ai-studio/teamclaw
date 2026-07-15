import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
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

  it('displays child session streaming content while viewing a child session', async () => {
    const ChatMessage = await importChatMessage();

    const message = makeMessage({
      sessionId: 'child-1',
      isStreaming: true,
      content: '',
    });

    useStreamingStore.setState({
      childSessionStreaming: {
        'child-1': {
          sessionId: 'child-1',
          text: 'Child stream in progress',
          reasoning: '',
          isStreaming: true,
        },
      },
    });

    const { container } = render(
      <ChatMessage message={message} activeSessionId="child-1" />
    );

    expect(container.textContent).toContain('Child stream in progress');
  });

  it('keeps persisted reasoning parts collapsed until opened', async () => {
    const ChatMessage = await importChatMessage();

    const message = makeMessage({
      content: 'Before tool.\n\nAfter tool.',
      parts: [
        {
          id: 'thinking-1',
          type: 'reasoning',
          text: 'Plan first.',
          content: 'Plan first.',
        },
        {
          id: 'text-before',
          type: 'text',
          text: 'Before tool.',
          content: 'Before tool.',
        },
        {
          id: 'thinking-2',
          type: 'reasoning',
          text: 'Plan second.',
          content: 'Plan second.',
        },
        {
          id: 'tool-1',
          type: 'tool-call',
          toolCallId: 'tool-1',
          toolCall: {
            id: 'tool-1',
            name: 'grep',
            status: 'completed',
            arguments: { pattern: 'needle' },
            result: 'result',
            startTime: new Date(0),
          },
        },
        {
          id: 'thinking-3',
          type: 'reasoning',
          text: 'Plan third.',
          content: 'Plan third.',
        },
        {
          id: 'text-after',
          type: 'text',
          text: 'After tool.',
          content: 'After tool.',
        },
      ],
      toolCalls: [
        {
          id: 'tool-1',
          name: 'grep',
          status: 'completed',
          arguments: { pattern: 'needle' },
          result: 'result',
          startTime: new Date(0),
        },
      ],
    });

    const { container } = render(<ChatMessage message={message} />);
    const text = container.textContent ?? '';
    expect(text).not.toContain('Plan first.');
    expect(text).not.toContain('Plan second.');
    expect(text).not.toContain('Plan third.');
    expect(text).toContain('Before tool.');
    expect(text).toContain('After tool.');

    const thinkingButtons = Array.from(container.querySelectorAll('button')).filter((button) =>
      button.textContent?.includes('Thinking Process'),
    );
    expect(thinkingButtons).toHaveLength(3);

    fireEvent.click(thinkingButtons[0]);
    fireEvent.click(thinkingButtons[1]);
    fireEvent.click(thinkingButtons[2]);

    const expandedText = container.textContent ?? '';
    const firstThinkingIndex = expandedText.indexOf('Plan first.');
    const beforeIndex = expandedText.indexOf('Before tool.');
    const secondThinkingIndex = expandedText.indexOf('Plan second.');
    const toolIndex = expandedText.indexOf('Grep');
    const thirdThinkingIndex = expandedText.indexOf('Plan third.');
    const afterIndex = expandedText.indexOf('After tool.');

    expect(firstThinkingIndex).toBeGreaterThanOrEqual(0);
    expect(beforeIndex).toBeGreaterThanOrEqual(0);
    expect(secondThinkingIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(thirdThinkingIndex).toBeGreaterThanOrEqual(0);
    expect(afterIndex).toBeGreaterThanOrEqual(0);
    expect(firstThinkingIndex).toBeLessThan(beforeIndex);
    expect(beforeIndex).toBeLessThan(secondThinkingIndex);
    expect(secondThinkingIndex).toBeLessThan(toolIndex);
    expect(toolIndex).toBeLessThan(thirdThinkingIndex);
    expect(thirdThinkingIndex).toBeLessThan(afterIndex);
  });
});

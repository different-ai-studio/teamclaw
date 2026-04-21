import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

async function importChatMessage() {
  const mod = await import('../ChatMessage');
  return mod.ChatMessage;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('ChatMessage', () => {
  beforeEach(() => {
    useStreamingStore.setState({
      streamingMessageId: null,
      streamingContent: '',
      streamingUpdateTrigger: 0,
      childSessionStreaming: {},
    });
    sessionLookupCache.clear();
    useSessionStore.setState({ activeSessionId: null });
  });

  it('user message renders its content', async () => {
    const ChatMessage = await importChatMessage();

    const message = makeMessage({
      id: 'msg-user-1',
      role: 'user',
      content: 'Hello from the user',
    });

    const { container } = render(<ChatMessage message={message} />);
    expect(container.textContent).toContain('Hello from the user');
  });

  it('assistant message renders its content', async () => {
    const ChatMessage = await importChatMessage();

    const message = makeMessage({
      id: 'msg-asst-1',
      role: 'assistant',
      content: 'Hello from the assistant',
      isStreaming: false,
    });

    useSessionStore.setState({ activeSessionId: 'sess-1' });
    sessionLookupCache.set('sess-1', {
      id: 'sess-1',
      messages: [message],
      updatedAt: new Date(),
    } as never);

    const { container } = render(<ChatMessage message={message} />);
    expect(container.textContent).toContain('Hello from the assistant');
  });

  it('only shows copy action on the last assistant text output in a group', async () => {
    const ChatMessage = await importChatMessage();

    const firstMessage = makeMessage({
      id: 'msg-asst-group-1',
      role: 'assistant',
      content: 'First assistant text',
      isStreaming: false,
    });

    const lastMessage = makeMessage({
      id: 'msg-asst-group-2',
      role: 'assistant',
      content: 'Last assistant text',
      isStreaming: false,
    });

    useSessionStore.setState({ activeSessionId: 'sess-1' });
    sessionLookupCache.set('sess-1', {
      id: 'sess-1',
      messages: [firstMessage, lastMessage],
      updatedAt: new Date(),
    } as never);

    const { rerender } = render(
      <ChatMessage
        message={firstMessage}
        tokenGroupInfo={{ hideTokenUsage: true }}
      />,
    );

    expect(screen.queryByTitle('Copy')).toBeNull();

    rerender(
      <ChatMessage
        message={lastMessage}
        tokenGroupInfo={{ hideTokenUsage: false }}
      />,
    );

    expect(screen.getByTitle('Copy')).toBeTruthy();
  });

  it('code blocks within messages render correctly', async () => {
    const ChatMessage = await importChatMessage();

    const message = makeMessage({
      id: 'msg-code-1',
      role: 'assistant',
      content: '```javascript\nconsole.log("hello");\n```',
      isStreaming: false,
    });

    useSessionStore.setState({ activeSessionId: 'sess-1' });
    sessionLookupCache.set('sess-1', {
      id: 'sess-1',
      messages: [message],
      updatedAt: new Date(),
    } as never);

    const { container } = render(<ChatMessage message={message} />);
    // Code blocks should render as code or pre elements
    const codeEl = container.querySelector('code, pre');
    expect(codeEl).not.toBeNull();
  });

  it('thinking indicator renders BEFORE message content during streaming', async () => {
    const ChatMessage = await importChatMessage();

    // Message with thinking parts but no content yet (early streaming state)
    const message = makeMessage({
      id: 'msg-thinking-1',
      role: 'assistant',
      content: '',
      parts: [{ id: 'step-1', type: 'step-start', text: 'Starting...' }],
      isStreaming: true,
    });

    useSessionStore.setState({ activeSessionId: 'sess-1' });
    useStreamingStore.setState({ streamingMessageId: 'msg-thinking-1', streamingContent: '' });
    sessionLookupCache.set('sess-1', {
      id: 'sess-1',
      messages: [message],
      updatedAt: new Date(),
    } as never);

    const { container } = render(<ChatMessage message={message} shouldShowThinking={true} />);
    
    // Thinking block should be present
    expect(container.textContent).toMatch(/Thinking|thinking|analyzing/i);
    
    // Get all direct children of the message container
    const messageContainer = container.querySelector('[data-testid="chat-message"]');
    expect(messageContainer).not.toBeNull();
    
    const firstChild = messageContainer?.firstElementChild;
    // First child should contain thinking-related content (Brain icon or "Thinking" text)
    expect(firstChild?.textContent).toMatch(/Thinking|analyzing/i);
  });
});

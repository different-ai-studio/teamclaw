import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock EventSource
class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  readyState = MockEventSource.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    // Auto-trigger onopen
    setTimeout(() => this.onopen?.(), 0);
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }
}

// @ts-expect-error - mock EventSource
globalThis.EventSource = MockEventSource;

// Import after mock
import { OpenCodeSSE } from '../sse';

describe('OpenCodeSSE - Long Task Support', () => {
  let sse: OpenCodeSSE;
  let handlers: {
    onConnected: ReturnType<typeof vi.fn>;
    onDisconnected: ReturnType<typeof vi.fn>;
    onInactivityWarning: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    handlers = {
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      onInactivityWarning: vi.fn(),
    };
    sse = new OpenCodeSSE('http://localhost:13141', 'test-session', handlers);
  });

  afterEach(() => {
    sse.disconnect();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('should start inactivity monitor on connect', async () => {
    sse.connect();
    await vi.advanceTimersByTimeAsync(0); // trigger onopen

    expect(handlers.onConnected).toHaveBeenCalled();
  });

  it('should emit inactivity warning after 30s of no events', async () => {
    sse.connect();
    await vi.advanceTimersByTimeAsync(0); // trigger onopen

    // Advance past inactivity threshold (30s) + check interval (10s)
    await vi.advanceTimersByTimeAsync(40000);

    expect(handlers.onInactivityWarning).toHaveBeenCalledWith(true);
  });

  it('should clear inactivity warning when event received', async () => {
    sse.connect();
    await vi.advanceTimersByTimeAsync(0); // trigger onopen

    // Trigger inactivity warning
    await vi.advanceTimersByTimeAsync(40000);
    expect(handlers.onInactivityWarning).toHaveBeenCalledWith(true);

    // Simulate receiving an SSE event
    const es = (sse as unknown as { eventSource: MockEventSource }).eventSource;
    es.onmessage?.({ data: JSON.stringify({ type: 'server.connected', properties: {} }) });

    expect(handlers.onInactivityWarning).toHaveBeenCalledWith(false);
  });

  it('should stop inactivity monitor on disconnect', async () => {
    sse.connect();
    await vi.advanceTimersByTimeAsync(0); // trigger onopen

    sse.disconnect();
    handlers.onInactivityWarning.mockClear();

    // Advance time - should NOT trigger warning after disconnect
    await vi.advanceTimersByTimeAsync(60000);
    expect(handlers.onInactivityWarning).not.toHaveBeenCalled();
  });

  it('should notify disconnected when EventSource closes', async () => {
    sse.connect();
    await vi.advanceTimersByTimeAsync(0); // trigger onopen

    // Simulate EventSource closing
    const es = (sse as unknown as { eventSource: MockEventSource }).eventSource;
    es.readyState = MockEventSource.CLOSED;
    es.onerror?.(new Error('connection lost'));

    expect(handlers.onDisconnected).toHaveBeenCalled();
  });
});

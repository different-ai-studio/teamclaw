import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

// ── Browser API polyfills ──────────────────────────────────────────────

// jsdom does not implement ResizeObserver; provide a no-op stub
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

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
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({ setFocus: vi.fn() })),
}));

// Session store state — mutated per test
const sessionState = {
  activeSessionId: null as string | null,
  sessions: [] as unknown[],
  error: null as string | null,
  isConnected: true,
  messageQueue: [] as unknown[],
  sessionError: null,
  inactivityWarning: false,
  draftInput: '',
  isLoading: false,
  pendingPermissions: [],
  pendingQuestions: [],
  todos: [],
  sessionDiff: [],
  sessionStatus: null,
  highlightedSessionIds: [],
  isLoadingMore: false,
  hasMoreSessions: false,
  visibleSessionCount: 50,
  selectedModel: null,
  sendMessage: vi.fn(),
  abortSession: vi.fn(),
  removeFromQueue: vi.fn(),
  loadSessions: vi.fn(() => Promise.resolve()),
  resetSessions: vi.fn(),
  clearSessionError: vi.fn(),
  setError: vi.fn(),
  setSelectedModel: vi.fn(),
  setDraftInput: vi.fn(),
  pollPermissions: vi.fn(),
  createSession: vi.fn(),
  setActiveSession: vi.fn(),
  archiveSession: vi.fn(),
  updateSessionTitle: vi.fn(),
  loadMoreSessions: vi.fn(),
  replyPermission: vi.fn(),
  answerQuestion: vi.fn(),
};

vi.mock('@/stores/session', () => {
  const useSessionStore = (selector: (s: typeof sessionState) => unknown) =>
    selector(sessionState);
  Object.assign(useSessionStore, {
    getState: () => sessionState,
    setState: (partial: Partial<typeof sessionState>) => Object.assign(sessionState, partial),
  });
  return {
    useSessionStore,
    sessionLookupCache: new Map(),
    getSessionById: vi.fn(() => null),
  };
});

const streamingState = {
  streamingMessageId: null as string | null,
  streamingContent: '',
  streamingUpdateTrigger: 0,
  childSessionStreaming: {} as Record<string, unknown>,
};

vi.mock('@/stores/streaming', () => {
  const useStreamingStore = (selector: (s: typeof streamingState) => unknown) =>
    selector(streamingState);
  Object.assign(useStreamingStore, {
    getState: () => streamingState,
    setState: (partial: Partial<typeof streamingState>) => Object.assign(streamingState, partial),
  });
  return { useStreamingStore };
});

const workspaceState = {
  workspacePath: '/test/workspace',
  openCodeReady: true,
};

vi.mock('@/stores/workspace', () => {
  const useWorkspaceStore = (selector: (s: typeof workspaceState) => unknown) =>
    selector(workspaceState);
  Object.assign(useWorkspaceStore, {
    getState: () => workspaceState,
    setState: (partial: Partial<typeof workspaceState>) => Object.assign(workspaceState, partial),
  });
  return { useWorkspaceStore };
});

const providerState = {
  models: [] as unknown[],
  configuredProvidersLoading: false,
  currentModelKey: null as string | null,
  initAll: vi.fn(),
};

vi.mock('@/stores/provider', () => {
  const useProviderStore = (selector: (s: typeof providerState) => unknown) =>
    selector(providerState);
  Object.assign(useProviderStore, {
    getState: () => providerState,
    setState: vi.fn(),
  });
  return {
    useProviderStore,
    getSelectedModelOption: () => null,
  };
});

const teamModeState = {
  teamMode: false,
  teamModelConfig: null,
  loadTeamConfig: vi.fn(() => Promise.resolve()),
  applyTeamModelToOpenCode: vi.fn(() => Promise.resolve()),
};

vi.mock('@/stores/team-mode', () => {
  const useTeamModeStore = (selector: (s: typeof teamModeState) => unknown) =>
    selector(teamModeState);
  Object.assign(useTeamModeStore, {
    getState: () => teamModeState,
    setState: vi.fn(),
  });
  return { useTeamModeStore };
});

const voiceInputState = {
  registerInsertToChatHandler: vi.fn(() => () => {}),
};

vi.mock('@/stores/voice-input', () => {
  const useVoiceInputStore = (selector: (s: typeof voiceInputState) => unknown) =>
    selector(voiceInputState);
  Object.assign(useVoiceInputStore, {
    getState: () => voiceInputState,
    setState: vi.fn(),
  });
  return { useVoiceInputStore };
});

vi.mock('@/stores/suggestions', () => ({
  useSuggestionsStore: (selector: (s: { customSuggestions: string[] }) => unknown) =>
    selector({ customSuggestions: [] }),
}));

vi.mock('@/lib/opencode/sdk-client', () => ({
  getOpenCodeClient: () => ({
    executeCommand: vi.fn(),
  }),
}));

// ── Import component after mocks ───────────────────────────────────────

import { ChatPanel } from '../ChatPanel';

// ── Tests ──────────────────────────────────────────────────────────────

describe('ChatPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.activeSessionId = null;
    sessionState.isConnected = true;
    sessionState.error = null;
    sessionState.sessionError = null;
    sessionState.draftInput = '';
    sessionState.messageQueue = [];
    sessionState.sessions = [];
    streamingState.streamingMessageId = null;
    workspaceState.openCodeReady = true;
    voiceInputState.registerInsertToChatHandler = vi.fn(() => () => {});
    sessionState.loadSessions = vi.fn(() => Promise.resolve());
    sessionState.resetSessions = vi.fn();
    sessionState.clearSessionError = vi.fn();
    sessionState.setError = vi.fn();
    sessionState.setSelectedModel = vi.fn();
    sessionState.setDraftInput = vi.fn();
    sessionState.pollPermissions = vi.fn();
    providerState.initAll = vi.fn();
    teamModeState.loadTeamConfig = vi.fn(() => Promise.resolve());
    teamModeState.applyTeamModelToOpenCode = vi.fn(() => Promise.resolve());
  });

  it('renders child components when session is active', () => {
    sessionState.activeSessionId = 'sess-1';
    sessionState.sessions = [
      { id: 'sess-1', title: 'Test session', messages: [], createdAt: new Date(), updatedAt: new Date() },
    ];

    const { container } = render(<ChatPanel />);
    expect(container.children.length).toBeGreaterThan(0);
    expect(container.firstChild).not.toBeNull();
  });

  it('shows connection-related text when isConnected is false', () => {
    sessionState.isConnected = false;
    sessionState.activeSessionId = 'sess-1';

    const { container } = render(<ChatPanel />);
    // When isConnected is false and there's an active session, the connecting indicator shows
    expect(container.textContent).toContain('Connecting');
  });
});

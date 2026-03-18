import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ChatInputArea } from '../ChatInputArea';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock('@/stores/provider', () => ({
  useProviderStore: (selector: (s: unknown) => unknown) =>
    selector({
      models: [],
      configuredProvidersLoading: false,
      selectModel: vi.fn(),
    }),
  getSelectedModelOption: () => null,
}));

vi.mock('@/lib/opencode/client', () => ({
  getOpenCodeClient: () => ({
    executeCommand: vi.fn(),
  }),
}));

const mockInsertToChat = vi.fn();
vi.mock('@/stores/voice-input', () => ({
  useVoiceInputStore: {
    getState: () => ({
      insertToChat: mockInsertToChat,
    }),
  },
}));

vi.mock('@/stores/workspace', () => {
  const state = { workspacePath: '/workspace/project' };
  const store = (selector: (s: typeof state) => unknown) => selector(state);
  store.getState = () => state;
  return { useWorkspaceStore: store };
});

// Use a global to control mockDraftInput from tests (vi.mock is hoisted)
(globalThis as Record<string, unknown>).__mockDraftInput = '';
vi.mock('@/stores/session', () => {
  const store = (_selector: unknown) => undefined;
  store.getState = () => ({ draftInput: (globalThis as Record<string, unknown>).__mockDraftInput });
  return { useSessionStore: store };
});

vi.mock('@/stores/team-mode', () => ({
  useTeamModeStore: (selector: (s: unknown) => unknown) =>
    selector({ teamMode: false }),
}));

// ── Polyfill DataTransfer for jsdom ──────────────────────────────────────────

class MockDataTransfer {
  private data = new Map<string, string>();
  items = [];
  files = [] as unknown as FileList;
  types: string[] = [];

  setData(format: string, data: string) {
    this.data.set(format, data);
    if (!this.types.includes(format)) this.types.push(format);
  }
  getData(format: string) {
    return this.data.get(format) ?? '';
  }
  clearData() {
    this.data.clear();
    this.types = [];
  }
  get effectAllowed() { return 'all'; }
  set effectAllowed(_v: string) { /* noop */ }
  get dropEffect() { return 'none'; }
  set dropEffect(_v: string) { /* noop */ }
}

// @ts-expect-error -- polyfill for jsdom
globalThis.DataTransfer = MockDataTransfer;

// ── Test helpers ─────────────────────────────────────────────────────────────

const defaultProps = {
  compact: false,
  inputValue: '',
  onInputChange: vi.fn(),
  attachedFiles: [] as string[],
  onFilesChange: vi.fn(),
  onRemoveFile: vi.fn(),
  imageFiles: [] as File[],
  onImageFilesChange: vi.fn(),
  onRemoveImageFile: vi.fn(),
  onSubmit: vi.fn(),
  isStreaming: false,
  onAbort: vi.fn(),
  messageQueue: [],
  onRemoveFromQueue: vi.fn(),
};

function dropFile(form: HTMLElement, filePath: string) {
  const dataTransfer = new MockDataTransfer();
  dataTransfer.setData('text/plain', filePath);
  dataTransfer.setData('application/x-teamclaw-filepath', filePath);

  fireEvent.dragOver(form, { dataTransfer });
  fireEvent.drop(form, { dataTransfer });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('File drag-and-drop to prompt input', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as Record<string, unknown>).__mockDraftInput = '';
  });

  it('inserts @{filepath} mention on file drop', () => {
    render(<ChatInputArea {...defaultProps} />);
    const form = document.querySelector('form')!;
    expect(form).toBeTruthy();

    dropFile(form, '/workspace/project/src/app.ts');

    expect(mockInsertToChat).toHaveBeenCalledWith('@{src/app.ts} ');
  });

  it('converts absolute path to relative using workspace path', () => {
    render(<ChatInputArea {...defaultProps} />);
    const form = document.querySelector('form')!;

    dropFile(form, '/workspace/project/config/settings.json');

    expect(mockInsertToChat).toHaveBeenCalledWith('@{config/settings.json} ');
  });

  it('keeps full path when file is outside workspace', () => {
    render(<ChatInputArea {...defaultProps} />);
    const form = document.querySelector('form')!;

    dropFile(form, '/other/location/file.txt');

    expect(mockInsertToChat).toHaveBeenCalledWith('@{/other/location/file.txt} ');
  });

  it('deduplicates same file dropped twice', () => {
    // Simulate draftInput already containing the file
    (globalThis as Record<string, unknown>).__mockDraftInput = '@{src/app.ts} ';

    render(<ChatInputArea {...defaultProps} />);
    const form = document.querySelector('form')!;

    dropFile(form, '/workspace/project/src/app.ts');

    expect(mockInsertToChat).not.toHaveBeenCalled();
  });
});

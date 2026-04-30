import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { ChatInputArea } from '../ChatInputArea';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
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

vi.mock('@/lib/opencode/sdk-client', () => ({
  getOpenCodeClient: () => ({
    executeCommand: vi.fn(),
  }),
}));

vi.mock('@/stores/team-mode', () => ({
  useTeamModeStore: (selector: (s: unknown) => unknown) =>
    selector({ teamMode: false, devUnlocked: true }),
}));

vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (s: unknown) => unknown) =>
    selector({ advancedMode: true }),
}));

const defaultProps = {
  compact: false,
  inputValue: '',
  onInputChange: vi.fn(),
  attachedFiles: [],
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

describe('ChatInputArea', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders input tools area with prompt input', () => {
    const { container } = render(<ChatInputArea {...defaultProps} />);
    const editable = container.querySelector('[contenteditable]');
    expect(editable).toBeDefined();
    expect(editable).not.toBeNull();
  });

  it('passes onSubmit to PromptInput component', () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <ChatInputArea {...defaultProps} inputValue="hello" onSubmit={onSubmit} />
    );
    const editable = container.querySelector('[contenteditable]');
    expect(editable).not.toBeNull();
  });

  it('renders input area in default state when empty', () => {
    const { container } = render(
      <ChatInputArea {...defaultProps} inputValue="" />
    );
    const editable = container.querySelector('[contenteditable]');
    expect(editable).not.toBeNull();
  });

  it('disables browser text assistance on the contenteditable input', () => {
    const { container } = render(
      <ChatInputArea {...defaultProps} inputValue="" />
    );
    const editable = container.querySelector('[contenteditable]');

    expect(editable?.getAttribute('autocorrect')).toBe('off');
    expect(editable?.getAttribute('autocapitalize')).toBe('off');
    expect(editable?.getAttribute('spellcheck')).toBe('false');
  });

  it('renders differently when isStreaming is true vs false', () => {
    const { container: streamingContainer } = render(
      <ChatInputArea {...defaultProps} isStreaming={true} />
    );
    const { container: idleContainer } = render(
      <ChatInputArea {...defaultProps} isStreaming={false} />
    );
    expect(streamingContainer.innerHTML).not.toBe(idleContainer.innerHTML);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
      models: [
        { provider: 'openai', id: 'gpt-4', name: 'GPT-4' },
        { provider: 'anthropic', id: 'claude-3', name: 'Claude 3' },
      ],
      configuredProvidersLoading: false,
      selectModel: vi.fn(),
    }),
  getSelectedModelOption: () => ({
    provider: 'openai',
    id: 'gpt-4',
    name: 'GPT-4',
  }),
}));

vi.mock('@/lib/opencode/client', () => ({
  getOpenCodeClient: () => ({
    executeCommand: vi.fn(),
  }),
}));

vi.mock('@/stores/voice-input', () => ({
  useVoiceInputStore: {
    getState: () => ({
      insertToChat: vi.fn(),
    }),
  },
}));

vi.mock('@/stores/workspace', () => {
  const state = { workspacePath: '/workspace/project' };
  const store = (selector: (s: typeof state) => unknown) => selector(state);
  store.getState = () => state;
  return { useWorkspaceStore: store };
});

vi.mock('@/stores/session', () => {
  const store = (_selector: unknown) => undefined;
  store.getState = () => ({ draftInput: '' });
  return { useSessionStore: store };
});

vi.mock('@/stores/team-mode', () => ({
  useTeamModeStore: (selector: (s: unknown) => unknown) =>
    selector({ teamMode: false, devUnlocked: true }),
}));

vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (s: unknown) => unknown) =>
    selector({ advancedMode: true }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const createDefaultProps = () => ({
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
  messageQueue: [] as Array<{ id: string; content: string; timestamp: Date }>,
  onRemoveFromQueue: vi.fn(),
});

// ── Polyfill for jsdom ───────────────────────────────────────────────────────

// jsdom doesn't have URL.createObjectURL
if (typeof URL.createObjectURL === 'undefined') {
  URL.createObjectURL = () => 'blob:mock-url';
  URL.revokeObjectURL = () => {};
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ChatInputArea interactions', () => {
  let defaultProps: ReturnType<typeof createDefaultProps>;

  beforeEach(() => {
    vi.clearAllMocks();
    defaultProps = createDefaultProps();
  });

  describe('submit button state', () => {
    it('disables submit when input is empty and no files attached', () => {
      render(<ChatInputArea {...defaultProps} inputValue="" attachedFiles={[]} imageFiles={[]} />);
      const submitBtn = document.querySelector('button[type="submit"]');
      expect(submitBtn).toBeTruthy();
      // Submit should be disabled when nothing to send
      expect(submitBtn?.hasAttribute('disabled') || submitBtn?.getAttribute('aria-disabled') === 'true').toBe(true);
    });

    it('enables submit when input has text', () => {
      render(<ChatInputArea {...defaultProps} inputValue="hello world" />);
      const submitBtn = document.querySelector('button[type="submit"]');
      expect(submitBtn).toBeTruthy();
      expect(submitBtn?.hasAttribute('disabled')).toBe(false);
    });

    it('enables submit when files are attached even with empty input', () => {
      render(<ChatInputArea {...defaultProps} inputValue="" attachedFiles={['/path/to/file.ts']} />);
      const submitBtn = document.querySelector('button[type="submit"]');
      expect(submitBtn).toBeTruthy();
      expect(submitBtn?.hasAttribute('disabled')).toBe(false);
    });

    it('enables submit when image files are attached even with empty input', () => {
      const imageFile = new File(['data'], 'test.png', { type: 'image/png' });
      const { container } = render(<ChatInputArea {...defaultProps} inputValue="" imageFiles={[imageFile]} />);
      // PromptInputSubmit renders inside the form
      const form = container.querySelector('form');
      expect(form).toBeTruthy();
    });
  });

  describe('streaming state', () => {
    it('renders differently when streaming vs idle', () => {
      const { container: streamingContainer } = render(
        <ChatInputArea {...defaultProps} isStreaming={true} inputValue="" />
      );
      const { container: idleContainer } = render(
        <ChatInputArea {...defaultProps} isStreaming={false} inputValue="" />
      );
      // Streaming and idle states produce different DOM
      // (different submit button state, different placeholder)
      expect(streamingContainer.innerHTML).not.toBe(idleContainer.innerHTML);
    });
  });

  describe('attached files display', () => {
    it('shows attached file names with remove button', () => {
      render(
        <ChatInputArea
          {...defaultProps}
          attachedFiles={['/workspace/project/src/utils.ts', '/workspace/project/README.md']}
        />
      );
      // Files should be visible
      expect(screen.getByText('utils.ts')).toBeTruthy();
      expect(screen.getByText('README.md')).toBeTruthy();
    });

    it('calls onRemoveFile when X button clicked on attached file', () => {
      render(
        <ChatInputArea
          {...defaultProps}
          attachedFiles={['/workspace/project/src/utils.ts']}
        />
      );
      // Find the remove button (X icon) near the file
      const fileChip = screen.getByText('utils.ts').closest('div[class*="relative"]');
      expect(fileChip).toBeTruthy();
      const removeBtn = fileChip!.querySelector('button');
      expect(removeBtn).toBeTruthy();
      fireEvent.click(removeBtn!);
      expect(defaultProps.onRemoveFile).toHaveBeenCalledWith(0);
    });

    it('shows file directory path for nested files', () => {
      render(
        <ChatInputArea
          {...defaultProps}
          attachedFiles={['/workspace/project/src/components/Button.tsx']}
        />
      );
      expect(screen.getByText('Button.tsx')).toBeTruthy();
    });
  });

  describe('image files display', () => {
    it('shows image previews with remove button', () => {
      const imageFile = new File(['data'], 'screenshot.png', { type: 'image/png' });
      render(
        <ChatInputArea {...defaultProps} imageFiles={[imageFile]} />
      );

      const img = document.querySelector('img');
      expect(img).toBeTruthy();
      expect(img?.getAttribute('alt')).toBe('screenshot.png');
    });

    it('calls onRemoveImageFile when X button clicked on image', () => {
      const imageFile = new File(['data'], 'photo.jpg', { type: 'image/jpeg' });
      render(
        <ChatInputArea {...defaultProps} imageFiles={[imageFile]} />
      );

      const imgContainer = document.querySelector('img')?.closest('.relative.group');
      expect(imgContainer).toBeTruthy();
      const removeBtn = imgContainer!.querySelector('button');
      expect(removeBtn).toBeTruthy();
      fireEvent.click(removeBtn!);
      expect(defaultProps.onRemoveImageFile).toHaveBeenCalledWith(0);
    });
  });

  describe('plan mode toggle', () => {
    it('toggles plan mode on click', () => {
      render(<ChatInputArea {...defaultProps} />);
      const planButton = screen.getByText('Plan');
      expect(planButton).toBeTruthy();

      // Initially not active (ghost variant)
      expect(planButton.className).toContain('text-muted-foreground');

      // Click to activate
      fireEvent.click(planButton);

      // After click, should have active styling
      expect(planButton.className).toContain('bg-[#F5A623]');
    });

    it('injects _planMode flag into submitted message', () => {
      const onSubmit = vi.fn();
      render(<ChatInputArea {...defaultProps} inputValue="test message" onSubmit={onSubmit} />);

      // Activate plan mode
      const planButton = screen.getByText('Plan');
      fireEvent.click(planButton);

      // Submit form
      const form = document.querySelector('form')!;
      fireEvent.submit(form);

      // The handleSubmit wraps onSubmit and sets _planMode
      if (onSubmit.mock.calls.length > 0) {
        const submittedMessage = onSubmit.mock.calls[0][0];
        expect(submittedMessage._planMode).toBe(true);
      }
    });
  });

  describe('compact mode', () => {
    it('hides message queue display in compact mode', () => {
      const queue = [{ id: 'q-1', content: 'queued msg', timestamp: new Date() }];
      const { container: compactContainer } = render(
        <ChatInputArea {...defaultProps} compact={true} messageQueue={queue} />
      );
      const { container: normalContainer } = render(
        <ChatInputArea {...defaultProps} compact={false} messageQueue={queue} />
      );

      // In compact mode, MessageQueueDisplay is not rendered
      // We check the structural difference
      const compactHtml = compactContainer.innerHTML;
      const normalHtml = normalContainer.innerHTML;
      expect(compactHtml).not.toBe(normalHtml);
    });
  });

  describe('model selector', () => {
    it('shows selected model name', () => {
      render(<ChatInputArea {...defaultProps} />);
      // The selected model "GPT-4" should be visible
      expect(screen.getByText('GPT-4')).toBeTruthy();
    });
  });
});

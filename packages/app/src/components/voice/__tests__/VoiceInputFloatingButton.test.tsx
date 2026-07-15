import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VoiceInputFloatingButton } from '../VoiceInputFloatingButton';

const mockStartListening = vi.fn();
const mockStopListening = vi.fn();
let capturedOnResult: ((t: string) => void) | null = null;
const mockReturn = {
  isListening: false,
  isSupported: true,
  isCheckingMic: false,
  startListening: mockStartListening,
  stopListening: mockStopListening,
  error: null as string | null,
};

vi.mock('@/hooks/useSpeechRecognition', () => ({
  useSpeechRecognition: (opts: { onResult: (t: string) => void; onListeningChange?: (listening: boolean) => void }) => {
    capturedOnResult = opts.onResult;
    return { ...mockReturn, startListening: mockStartListening, stopListening: mockStopListening };
  },
}));

vi.mock('@/hooks/useTauriStt', () => ({
  useTauriStt: () => ({
    isSupported: false,
    isCheckingMic: false,
    isListening: false,
    startListening: () => {},
    stopListening: () => {},
    error: null,
  }),
}));

vi.mock('@/lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils')>();
  return { ...actual, isTauri: () => false };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock('@/stores/session', () => ({
  useSessionStore: (s: (state: { activeSessionId: string | null }) => unknown) =>
    s({ activeSessionId: 'test-session' }),
}));

const mockSetLastTranscript = vi.fn();
const mockInsertToChat = vi.fn();
const mockSetListening = vi.fn();
const mockSetRecognizing = vi.fn();
const mockVoiceInputState = {
  voiceEnabled: true,
  lastTranscript: null,
  setLastTranscript: mockSetLastTranscript,
  insertToChat: mockInsertToChat,
  isListening: false,
  setListening: mockSetListening,
  isRecognizing: false,
  setRecognizing: mockSetRecognizing,
};
vi.mock('@/stores/voice-input', () => ({
  useVoiceInputStore: Object.assign(
    (selector?: (state: unknown) => unknown) => {
      const state = mockVoiceInputState;
      return typeof selector === 'function' ? selector(state) : state;
    },
    { getState: () => mockVoiceInputState },
  ),
}));

describe('VoiceInputFloatingButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnResult = null;
    mockReturn.isSupported = true;
    mockReturn.error = null;
  });

  it('renders floating microphone button', () => {
    render(<VoiceInputFloatingButton />);
    expect(screen.getByTestId('voice-input-floating-button')).toBeDefined();
  });

  it('calls startListening when clicked', () => {
    render(<VoiceInputFloatingButton />);
    fireEvent.click(screen.getByTestId('voice-input-floating-button'));
    expect(mockStartListening).toHaveBeenCalled();
  });

  it('calls stopListening when clicked while recording', () => {
    mockReturn.isListening = true;
    mockVoiceInputState.isListening = true;
    render(<VoiceInputFloatingButton />);
    fireEvent.click(screen.getByTestId('voice-input-floating-button'));
    expect(mockStopListening).toHaveBeenCalled();
    mockReturn.isListening = false;
    mockVoiceInputState.isListening = false;
  });

  it('shows explicit Stop button when recording and clicking it stops', () => {
    mockReturn.isListening = true;
    mockVoiceInputState.isListening = true;
    render(<VoiceInputFloatingButton />);
    expect(screen.getByTestId('voice-input-stop-button')).toBeDefined();
    fireEvent.click(screen.getByTestId('voice-input-stop-button'));
    expect(mockSetListening).toHaveBeenCalledWith(false);
    expect(mockStopListening).toHaveBeenCalled();
    mockReturn.isListening = false;
    mockVoiceInputState.isListening = false;
  });

  it('sets lastTranscript in store when onResult is called', () => {
    render(<VoiceInputFloatingButton />);
    expect(capturedOnResult).not.toBeNull();
    capturedOnResult!('hello world');
    expect(mockSetLastTranscript).toHaveBeenCalledWith('hello world');
  });
});

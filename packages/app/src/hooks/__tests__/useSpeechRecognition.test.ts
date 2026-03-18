import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSpeechRecognition } from '../useSpeechRecognition';

describe('useSpeechRecognition', () => {
  let mockRecognition: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
  };

  const mockEnumerateDevices = vi.fn();

  beforeEach(() => {
    mockRecognition = {
      start: vi.fn(),
      stop: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    (globalThis as unknown as { SpeechRecognition: unknown }).SpeechRecognition = vi.fn(() => mockRecognition);
    (globalThis as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition = vi.fn(() => mockRecognition);

    Object.defineProperty(navigator, 'mediaDevices', {
      value: { enumerateDevices: mockEnumerateDevices },
      writable: true,
      configurable: true,
    });
    mockEnumerateDevices.mockResolvedValue([{ kind: 'audioinput', deviceId: 'default' }]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    mockEnumerateDevices.mockReset();
    delete (globalThis as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    delete (globalThis as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  });

  it('returns isSupported true when SpeechRecognition and microphone are available', async () => {
    mockEnumerateDevices.mockResolvedValue([{ kind: 'audioinput', deviceId: 'default' }]);

    const { result } = renderHook(() =>
      useSpeechRecognition({ onResult: vi.fn() })
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.isSupported).toBe(true);
  });

  it('returns isSupported false when SpeechRecognition is absent', async () => {
    delete (globalThis as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    delete (globalThis as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;

    const { result } = renderHook(() =>
      useSpeechRecognition({ onResult: vi.fn() })
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.isSupported).toBe(false);
  });

  it('startListening sets isListening to true and calls recognition.start', async () => {
    const { result } = renderHook(() =>
      useSpeechRecognition({ onResult: vi.fn() })
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.isListening).toBe(false);
    act(() => {
      result.current.startListening();
    });
    expect(result.current.isListening).toBe(true);
    expect(mockRecognition.start).toHaveBeenCalled();
  });

  it('stopListening sets isListening to false and calls recognition.stop', async () => {
    const { result } = renderHook(() =>
      useSpeechRecognition({ onResult: vi.fn() })
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    act(() => {
      result.current.startListening();
    });
    expect(result.current.isListening).toBe(true);

    act(() => {
      result.current.stopListening();
    });
    expect(result.current.isListening).toBe(false);
    expect(mockRecognition.stop).toHaveBeenCalled();
  });

  it('calls onResult with transcript when result event fires with isFinal', async () => {
    const onResult = vi.fn();
    const { result } = renderHook(() =>
      useSpeechRecognition({ onResult })
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    act(() => {
      result.current.startListening();
    });

    const resultHandler = mockRecognition.addEventListener.mock.calls.find(
      (c: [string, () => void]) => c[0] === 'result'
    )?.[1];
    expect(resultHandler).toBeDefined();

    const mockResult = {
      length: 1,
      isFinal: true,
      0: { transcript: 'hello world', confidence: 1 },
    };
    const mockEvent = { results: [mockResult] };
    act(() => {
      resultHandler?.({ results: mockEvent.results } as SpeechRecognitionEvent);
    });

    expect(onResult).toHaveBeenCalledWith('hello world');
  });

  it('sets error when recognition emits error event', async () => {
    const { result } = renderHook(() =>
      useSpeechRecognition({ onResult: vi.fn() })
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    act(() => {
      result.current.startListening();
    });

    const errorHandler = mockRecognition.addEventListener.mock.calls.find(
      (c: [string, () => void]) => c[0] === 'error'
    )?.[1];
    expect(errorHandler).toBeDefined();

    act(() => {
      errorHandler?.({ error: 'not-allowed' } as SpeechRecognitionErrorEvent);
    });

    expect(result.current.error).toBe('not-allowed');
  });

  describe('microphone detection', () => {
    it('returns isSupported false when no audio input devices', async () => {
      mockEnumerateDevices.mockResolvedValue([]);

      const { result } = renderHook(() =>
        useSpeechRecognition({ onResult: vi.fn() })
      );

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(result.current.isSupported).toBe(false);
    });

    it('returns isSupported true when audio input devices exist', async () => {
      mockEnumerateDevices.mockResolvedValue([
        { kind: 'audioinput', deviceId: 'default' },
        { kind: 'audiooutput', deviceId: 'speaker' },
      ]);

      const { result } = renderHook(() =>
        useSpeechRecognition({ onResult: vi.fn() })
      );

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(result.current.isSupported).toBe(true);
    });

    it('returns isSupported false when only audio output devices exist', async () => {
      mockEnumerateDevices.mockResolvedValue([
        { kind: 'audiooutput', deviceId: 'speaker' },
      ]);

      const { result } = renderHook(() =>
        useSpeechRecognition({ onResult: vi.fn() })
      );

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(result.current.isSupported).toBe(false);
    });
  });
});
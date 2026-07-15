import { useState, useEffect, useCallback, useRef } from 'react';
import { isTauri } from '@/lib/utils';
import { appShortName } from '@/lib/build-config';

/** Map UI locale (e.g. en, zh-CN) to Whisper language code. Returns undefined for auto-detect. */
function uiLocaleToWhisperLang(): string | undefined {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(`${appShortName}-language`) : null;
  const lang = stored || (typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en');
  if (lang.startsWith('zh')) return 'zh';
  if (lang.startsWith('en')) return 'en';
  if (lang.startsWith('ja')) return 'ja';
  if (lang.startsWith('ko')) return 'ko';
  if (lang.startsWith('de')) return 'de';
  if (lang.startsWith('fr')) return 'fr';
  if (lang.startsWith('es')) return 'es';
  return undefined;
}

export interface UseTauriSttOptions {
  onResult: (transcript: string) => void;
  onListeningChange?: (listening: boolean) => void;
}

interface SttAvailableResult {
  available: boolean;
  reason?: string;
}

interface SttTranscriptPayload {
  partial?: boolean;
  text: string;
}

const DUMMY_RET = {
  isSupported: false,
  isCheckingMic: false,
  isListening: false,
  startListening: () => {},
  stopListening: () => {},
  error: null as string | null,
};

export function useTauriStt({ onResult, onListeningChange }: UseTauriSttOptions) {
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCheckingMic, setIsCheckingMic] = useState(true);
  const [isSupported, setIsSupported] = useState(false);
  const transcriptRef = useRef('');
  const onListeningChangeRef = useRef(onListeningChange);
  onListeningChangeRef.current = onListeningChange;

  const setListening = useCallback((v: boolean) => {
    setIsListening(v);
    onListeningChangeRef.current?.(v);
  }, []);

  useEffect(() => {
    if (!isTauri()) {
      setIsCheckingMic(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const r = await invoke<SttAvailableResult>('stt_is_available');
        if (!cancelled) {
          setIsSupported(r.available ?? false);
          if (!r.available && r.reason) setError(r.reason);
        }
      } catch (e) {
        if (!cancelled) {
          setIsSupported(false);
          setError(e instanceof Error ? e.message : 'STT unavailable');
        }
      } finally {
        if (!cancelled) setIsCheckingMic(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isTauri() || !isSupported) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen<SttTranscriptPayload>('stt:transcript', (e) => {
          const t = (e.payload?.text ?? '').trim();
          if (!t) return;
          transcriptRef.current = transcriptRef.current ? `${transcriptRef.current} ${t}` : t;
          onResult(transcriptRef.current);
        });
      } catch (e) {
        if (import.meta.env.DEV) console.warn('[Voice] Tauri STT transcript listener failed', e);
      }
    })();
    return () => {
      unlisten?.();
    };
  }, [isSupported, onResult]);

  const startListening = useCallback(async () => {
    if (!isTauri() || !isSupported) return;
    setError(null);
    transcriptRef.current = '';
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const language = uiLocaleToWhisperLang();
      await invoke('stt_start_listening', { language: language ?? null });
      setListening(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to start';
      setError(msg);
      if (import.meta.env.DEV) console.warn('[Voice] Tauri STT startListening error', e);
    }
  }, [isSupported, setListening]);

  const stopListening = useCallback(async () => {
    if (!isTauri()) return;
    setListening(false);
    setError(null);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('stt_stop_listening');
    } catch (e) {
      if (import.meta.env.DEV) console.warn('[Voice] Tauri STT stopListening error', e);
    }
  }, [setListening]);

  useEffect(() => {
    if (!isListening) transcriptRef.current = '';
  }, [isListening]);

  if (!isTauri()) return DUMMY_RET;

  return {
    isSupported,
    isCheckingMic,
    isListening,
    startListening: () => {
      void startListening();
    },
    stopListening: () => {
      void stopListening();
    },
    error,
  };
}

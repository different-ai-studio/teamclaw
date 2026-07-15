import { useState, useEffect, useCallback, useRef } from 'react';

type SpeechRecognitionCtor = typeof window extends { SpeechRecognition?: infer C } ? C : never;

function getSpeechRecognitionAPI(): SpeechRecognitionCtor {
  if (typeof window === 'undefined') return null as unknown as SpeechRecognitionCtor;
  const ctor = (window as Window & { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor }).SpeechRecognition
    ?? (window as Window & { webkitSpeechRecognition?: SpeechRecognitionCtor }).webkitSpeechRecognition;
  return ctor ?? (null as unknown as SpeechRecognitionCtor);
}

async function hasMicrophone(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    return false;
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.some((d) => d.kind === 'audioinput');
  } catch {
    return false;
  }
}

export interface UseSpeechRecognitionOptions {
  onResult: (transcript: string) => void;
  /** Sync listening state to store so Tauri WebView UI updates reliably */
  onListeningChange?: (listening: boolean) => void;
}

export function useSpeechRecognition({ onResult, onListeningChange }: UseSpeechRecognitionOptions) {
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMic, setHasMic] = useState<boolean | null>(null);
  const recognitionRef = useRef<InstanceType<NonNullable<SpeechRecognitionCtor>> | null>(null);
  const onListeningChangeRef = useRef(onListeningChange);
  onListeningChangeRef.current = onListeningChange;

  const api = getSpeechRecognitionAPI();
  const isSupported = api !== null && hasMic === true;

  const setListening = useCallback((v: boolean) => {
    setIsListening(v);
    onListeningChangeRef.current?.(v);
  }, []);

  useEffect(() => {
    hasMicrophone().then(setHasMic);
  }, []);

  const startListening = useCallback(() => {
    if (!api) return;
    setError(null);
    const recognition = new api();
    recognitionRef.current = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.addEventListener('result', (e: Event) => {
      let full = '';
      try {
        const ev = e as SpeechRecognitionEvent;
        const results = ev?.results;
        if (results != null && typeof results.length === 'number') {
          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (r == null) continue;
            const len = typeof r.length === 'number' ? r.length : 0;
            const item = len > 0 ? r[len - 1] : null;
            const t = item && typeof (item as { transcript?: string }).transcript === 'string' ? (item as { transcript: string }).transcript.trim() : '';
            if (t) full += (full ? ' ' : '') + t;
          }
        }
      } catch (err) {
        if (import.meta.env.DEV) console.warn('[Voice] result handler error', err);
      }
      if (full) onResult(full);
    });

    recognition.addEventListener('end', () => {
      recognitionRef.current = null;
      setListening(false);
    });

    recognition.addEventListener('error', (e: Event) => {
      setError((e as SpeechRecognitionErrorEvent).error);
    });

    recognition.start();
    setListening(true);
  }, [onResult, api, setListening]);

  const stopListening = useCallback(() => {
    if (import.meta.env.DEV) {
      console.log('[Voice] stopListening called', { hadRef: !!recognitionRef.current });
    }
    setListening(false);
    setError(null);
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (err) {
        if (import.meta.env.DEV) console.warn('[Voice] recognition.stop() error', err);
      }
      recognitionRef.current = null;
    }
  }, [setListening]);

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, []);

  return {
    isListening,
    isSupported,
    isCheckingMic: hasMic === null,
    startListening,
    stopListening,
    error,
  };
}

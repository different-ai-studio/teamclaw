import { create } from 'zustand';
import { appShortName } from '@/lib/build-config';

const VOICE_ENABLED_KEY = `${appShortName}-voice-enabled`;

/** Store for global voice input: transcript is stored after recording, user decides where to put it */
interface VoiceInputState {
  /** Whether voice input feature is enabled. When false, button is hidden and shortcuts are ignored. */
  voiceEnabled: boolean;
  setVoiceEnabled: (v: boolean) => void;
  /** Latest transcript from voice recognition. Shown in floating bubble until cleared. */
  lastTranscript: string | null;
  setLastTranscript: (text: string | null) => void;
  /** Whether recognition is active. In store so Tauri WebView reliably re-renders on stop. */
  isListening: boolean;
  setListening: (v: boolean) => void;
  /** True after stopping recording until transcript arrives (or timeout). Used for "recognizing" animation. */
  isRecognizing: boolean;
  setRecognizing: (v: boolean) => void;
  /** Optional: insert into chat when user clicks "Insert to chat". Handler registered by ChatPanel. */
  _insertToChatHandler: ((text: string) => void) | null;
  registerInsertToChatHandler: (handler: (text: string) => void) => () => void;
  insertToChat: (text: string) => void;
}

export const useVoiceInputStore = create<VoiceInputState>((set, get) => ({
  voiceEnabled: (() => {
    try { const v = localStorage.getItem(VOICE_ENABLED_KEY); return v === null ? true : v === 'true'; }
    catch { return true; }
  })(),
  setVoiceEnabled: (v) => {
    try { localStorage.setItem(VOICE_ENABLED_KEY, String(v)); } catch { /* intentionally empty */ }
    set({ voiceEnabled: v });
  },
  lastTranscript: null,
  setLastTranscript: (text) => {
    set({ lastTranscript: text });
  },
  isListening: false,
  setListening: (v) => {
    set({ isListening: v });
  },
  isRecognizing: false,
  setRecognizing: (v) => set({ isRecognizing: v }),
  _insertToChatHandler: null,
  registerInsertToChatHandler: (handler) => {
    set({ _insertToChatHandler: handler });
    return () => set({ _insertToChatHandler: null });
  },
  insertToChat: (text) => {
    const handler = get()._insertToChatHandler;
    if (handler) handler(text);
  },
}));

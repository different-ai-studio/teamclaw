import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Mic, Copy, MessageSquarePlus, X, Square, Loader2 } from 'lucide-react';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import { useTauriStt } from '@/hooks/useTauriStt';
import { useVoiceInputStore } from '@/stores/voice-input';
import { useSessionStore } from '@/stores/session';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn, isTauri, copyToClipboard } from '@/lib/utils';

/** Global floating voice input button - bottom-right.
 *  Record first, transcript shows above the button. User copies or inserts to chat. */
export function VoiceInputFloatingButton() {
  const { t } = useTranslation();
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const {
    voiceEnabled,
    lastTranscript,
    setLastTranscript,
    insertToChat,
    isListening: isListeningStore,
    setListening: setListeningStore,
    isRecognizing,
    setRecognizing,
  } = useVoiceInputStore();

  if (!voiceEnabled) return null;

  const onResult = React.useCallback(
    (transcript: string) => {
      setLastTranscript(transcript);
      setRecognizing(false);
    },
    [setLastTranscript, setRecognizing],
  );

  const onListeningChange = React.useCallback(
    (listening: boolean) => setListeningStore(listening),
    [setListeningStore],
  );
  const webStt = useSpeechRecognition({ onResult, onListeningChange });
  const tauriStt = useTauriStt({ onResult, onListeningChange });
  const stt = isTauri() ? tauriStt : webStt;
  const { isSupported, isCheckingMic, startListening, stopListening, error } = stt;

  const isListening = isListeningStore;
  const [showDesktopUnsupportedHint, setShowDesktopUnsupportedHint] = React.useState(false);

  const isDisabled = !isSupported || !!error || isCheckingMic;

  const handleClick = React.useCallback(() => {
    if (isDisabled || isRecognizing) return;
    if (isListening) {
      stopListening();
      setRecognizing(true);
    } else {
      setLastTranscript(null);
      setShowDesktopUnsupportedHint(false);
      setRecognizing(false);
      startListening();
    }
  }, [isDisabled, isRecognizing, isListening, startListening, stopListening, setLastTranscript, setRecognizing]);

  const handleStopRecording = React.useCallback(
    (e: React.MouseEvent | React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (import.meta.env.DEV) console.log('[Voice] Stop button pressed', { isListening });
      if (!isListening) return;
      const hadTranscript = !!useVoiceInputStore.getState().lastTranscript;
      setListeningStore(false);
      setRecognizing(true);
      stopListening();
      if (isTauri() && !hadTranscript && !tauriStt.isSupported) setShowDesktopUnsupportedHint(true);
    },
    [isListening, stopListening, setListeningStore, setRecognizing, tauriStt.isSupported],
  );

  const handleCopy = React.useCallback(() => {
    if (!lastTranscript) return;
    copyToClipboard(lastTranscript);
    setLastTranscript(null);
  }, [lastTranscript, setLastTranscript]);

  const handleInsertToChat = React.useCallback(() => {
    if (!lastTranscript) return;
    insertToChat(lastTranscript);
    setLastTranscript(null);
  }, [lastTranscript, insertToChat, setLastTranscript]);

  const handleDismiss = React.useCallback(() => {
    setLastTranscript(null);
    setShowDesktopUnsupportedHint(false);
  }, [setLastTranscript]);

  const hasActiveSession = !!activeSessionId;
  const canInsertToChat = hasActiveSession && lastTranscript;

  const tooltipText =
    isCheckingMic
      ? t('chat.voiceInputChecking', 'Checking microphone...')
      : !isSupported
        ? (error && error !== 'not-allowed'
            ? error
            : t('chat.voiceInputNoMicrophone', 'No microphone detected'))
        : error === 'not-allowed'
          ? t('chat.voiceInputPermissionDenied', 'Microphone permission denied - click to retry')
          : isListening
            ? t('chat.voiceInputStop', 'Stop recording')
            : t('chat.voiceInputStart', 'Start voice input');

  React.useEffect(() => {
    if (!isRecognizing) return;
    const t = setTimeout(() => setRecognizing(false), 60_000);
    return () => clearTimeout(t);
  }, [isRecognizing, setRecognizing]);

  return (
    <div className="fixed bottom-6 right-6 z-[9998] flex flex-col items-end gap-2 isolate">
      {/* Transcript bubble or desktop-unsupported hint */}
      {(lastTranscript || showDesktopUnsupportedHint) && (
        <div
          className="flex flex-col gap-2 rounded-lg border bg-popover px-3 py-2 shadow-lg max-w-[280px] animate-in fade-in slide-in-from-bottom-2"
          data-testid="voice-transcript-bubble"
        >
          {lastTranscript ? (
            <p className="text-sm text-foreground break-words">{lastTranscript}</p>
          ) : (
            <p className="text-sm text-muted-foreground">{t('chat.voiceInputDesktopNoTranscript', 'Speech-to-text is not supported in the desktop app. Use the web version for voice input.')}</p>
          )}
          <div className="flex items-center gap-1">
            {lastTranscript && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
                    title={t('common.copy', 'Copy')}
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="z-[10000]">{t('common.copy', 'Copy')}</TooltipContent>
              </Tooltip>
            )}
            {canInsertToChat && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleInsertToChat}
                    className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
                    title={t('chat.voiceInputInsertToChat', 'Insert to chat')}
                  >
                    <MessageSquarePlus className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="z-[10000]">
                  {t('chat.voiceInputInsertToChat', 'Insert to chat')}
                </TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleDismiss}
                  className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
                  title={t('common.close', 'Close')}
                >
                  <X className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="z-[10000]">{t('common.close', 'Close')}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      )}

      {/* When recording: explicit Stop pill so user can always end */}
      {isListening && (
        <button
          type="button"
          onClick={handleStopRecording}
          onPointerDown={handleStopRecording}
          className="flex items-center gap-2 rounded-full bg-red-500/90 text-white px-4 py-2 shadow-lg hover:bg-red-500 cursor-pointer text-sm font-medium select-none"
          data-testid="voice-input-stop-button"
          aria-label={t('chat.voiceInputStop', 'Stop recording')}
        >
          <Square className="h-4 w-4 fill-current pointer-events-none" />
          <span className="pointer-events-none">{t('chat.voiceInputStop', 'Stop recording')}</span>
        </button>
      )}

      {/* Mic button */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleClick}
            aria-disabled={isDisabled || isRecognizing}
            aria-pressed={isListening}
            aria-busy={isRecognizing}
            data-testid="voice-input-floating-button"
            className={cn(
              'flex h-12 w-12 items-center justify-center rounded-full shadow-lg transition-colors',
              'bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground',
              isDisabled && 'opacity-50 cursor-not-allowed',
              !isDisabled && !isRecognizing && 'cursor-pointer',
              isListening && 'bg-red-500/20 text-red-500 ring-2 ring-red-500/50',
              isRecognizing &&
                'bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-2 ring-amber-500/40 animate-pulse',
            )}
          >
            {isRecognizing ? (
              <Loader2 className="h-6 w-6 animate-spin text-amber-600 dark:text-amber-400" aria-hidden />
            ) : (
              <Mic
                className={cn(
                  'h-6 w-6',
                  isListening && 'animate-pulse',
                )}
              />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="left" className={isListening || isRecognizing ? 'pointer-events-none' : undefined}>
          {isRecognizing
            ? t('chat.voiceInputRecognizing', 'Recognizing...')
            : tooltipText}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

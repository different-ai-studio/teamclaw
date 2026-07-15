import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";

export type VoiceRecorder = {
  isRecording: boolean;
  durationMs: number;
  start: () => Promise<void>;
  stop: () => Promise<string | null>;
};

/**
 * Thin React hook over `expo-audio`'s recorder primitives. Mirrors the
 * iOS `VoiceRecorder` behavior: ask for mic permission, start a
 * pre-configured high-quality recording, expose its running state, and
 * surface the file URI on stop. Callers are responsible for shipping
 * that URI to wherever the message attachment lives.
 */
export function useVoiceRecorder(): VoiceRecorder {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder);

  return {
    isRecording: state.isRecording,
    durationMs: state.durationMillis ?? 0,
    async start() {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        throw new Error("Microphone permission denied.");
      }
      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: true,
      });
      await recorder.prepareToRecordAsync();
      recorder.record();
    },
    async stop() {
      if (!state.isRecording) return null;
      await recorder.stop();
      return recorder.uri ?? null;
    },
  };
}

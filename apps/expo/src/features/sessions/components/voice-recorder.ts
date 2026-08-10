import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";

import { normalizeMeteringLevel } from "../voice-level";

export type VoiceRecorder = {
  isRecording: boolean;
  durationMs: number;
  /** Normalised 0…1 input level, for the recording waveform. */
  level: number;
  start: () => Promise<void>;
  stop: () => Promise<string | null>;
};

export function useVoiceRecorder(): VoiceRecorder {
  // Metering is off in the stock preset; the waveform needs it.
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  });
  // Poll fast enough for the bars to track the voice rather than lag it.
  const state = useAudioRecorderState(recorder, 100);

  return {
    isRecording: state.isRecording,
    durationMs: state.durationMillis ?? 0,
    level: normalizeMeteringLevel(state.metering),
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

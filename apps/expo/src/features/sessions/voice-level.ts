/**
 * Pure arithmetic behind the recording waveform, kept out of the component so
 * it can be tested without pulling React Native's Flow sources into vitest.
 */

/**
 * Convert `expo-audio`'s decibel metering to the 0…1 level iOS derives.
 *
 * iOS sums the raw buffer's absolute sample values, takes the mean, and scales
 * by 5 (`VoiceRecorder.swift`) — a *linear amplitude*. `expo-audio` reports dBFS
 * instead, so undo the log first (`10^(dB/20)`) and then apply the same ×5, or
 * the bars would sit pinned at either end.
 */
export function normalizeMeteringLevel(decibels: number | undefined): number {
  if (decibels === undefined || Number.isNaN(decibels)) return 0;
  // -160 dBFS is the conventional floor for "silence".
  if (decibels <= -160) return 0;
  const amplitude = Math.pow(10, Math.min(0, decibels) / 20);
  return Math.min(1, Math.max(0, amplitude * 5));
}

/**
 * Height of one waveform bar, matching the iOS `RecordingWaveform.barHeight`
 * arithmetic exactly so both apps swing the same amount for the same input:
 * a continuous sine per bar, biased and scaled by the live level, so silence
 * still pulses and loud moments swing wider.
 */
export function waveformBarHeight(args: {
  index: number;
  barCount: number;
  level: number;
  time: number;
}): number {
  const level = Math.min(1, Math.max(0, args.level));
  const phase = (args.index / args.barCount) * Math.PI * 2;
  const wave = Math.sin(args.time * 6 + phase) * 0.4;
  const amplitude = 0.25 + level * 0.6;
  const height = Math.max(0.15, Math.min(1, amplitude + wave * (0.4 + level * 0.6)));
  return 4 + height * 22;
}

export type DaemonConnectionState =
  | "connected"
  | "connecting"
  | "reconnecting"
  | "disconnected";

/** Mirrors the iOS `DaemonStatusBanner.label`. */
export function daemonStatusLabel(state: DaemonConnectionState): string {
  if (state === "connected") return "daemon online";
  if (state === "connecting" || state === "reconnecting") return "daemon connecting";
  return "daemon offline";
}

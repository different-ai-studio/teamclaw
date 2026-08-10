import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, StyleSheet, Text, View } from "react-native";

import { colors, hai, iosType, spacing } from "../../../ui/theme";
import { waveformBarHeight } from "../voice-level";

/**
 * Live recording indicator, ported from the iOS `RecordingWaveform`: a waveform
 * glyph, a row of bars, and a "Recording…" label.
 *
 * The bars ride a continuous sine wave biased by the live input level, so a
 * silent moment still pulses gently and a loud one swings wide. iOS drives this
 * from a `TimelineView(.animation)` tick; RN has no equivalent, so the phase is
 * advanced on an interval — and stopped outright under Reduce Motion, where the
 * bars hold at their level-derived height.
 */

export type RecordingWaveformProps = {
  /** 0…1 normalised input level. */
  level: number;
  barCount?: number;
};

/** iOS advances `sin(time * 6 + phase)`; 60ms ticks read as continuous. */
const TICK_MS = 60;

export function RecordingWaveform({ level, barCount = 7 }: RecordingWaveformProps) {
  const [time, setTime] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (!cancelled) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduceMotion,
    );
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (reduceMotion) return;
    const id = setInterval(() => {
      setTime((Date.now() - startedAt.current) / 1000);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [reduceMotion]);

  // Held at t=0 under Reduce Motion: the bars still reflect the level, they
  // just don't travel.
  const t = reduceMotion ? 0 : time;

  return (
    <View accessibilityLabel="Recording" style={styles.row}>
      <Ionicons color={hai.cinnabarDeep} name="pulse-outline" size={16} />
      <View style={styles.bars}>
        {Array.from({ length: barCount }, (_, index) => (
          <View
            key={index}
            style={[
              styles.bar,
              { height: waveformBarHeight({ index, barCount, level, time: t }) },
            ]}
          />
        ))}
      </View>
      <Text style={styles.label}>Recording…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: "rgba(142,58,44,0.85)",
    borderRadius: 1.5,
    width: 3,
  },
  bars: {
    alignItems: "center",
    flexDirection: "row",
    gap: 3,
    height: 26,
  },
  label: {
    color: colors.basalt,
    paddingLeft: 6,
    ...iosType.subheadline,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.xs,
  },
});

export default RecordingWaveform;

import { Ionicons } from "@expo/vector-icons";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, hai, radii, spacing, typography } from "../../../ui/theme";

export type AudioPlayerChipProps = {
  isOwn: boolean;
  url: string;
};

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Inline voice-memo chip that mirrors the iOS playback row inside an
 * attachment bubble. Uses expo-audio's `useAudioPlayer` hook so each
 * chip owns its own player instance — multiple memos in a single
 * session don't fight over a shared audio session.
 */
export function AudioPlayerChip({ isOwn, url }: AudioPlayerChipProps) {
  const player = useAudioPlayer(url);
  const status = useAudioPlayerStatus(player);
  const duration = status.duration ?? 0;
  const elapsed = status.currentTime ?? 0;
  const isPlaying = status.playing ?? false;

  const handleToggle = () => {
    if (isPlaying) {
      player.pause();
      return;
    }
    if (status.didJustFinish || (duration > 0 && elapsed >= duration - 0.05)) {
      player.seekTo(0);
    }
    player.play();
  };

  return (
    <View style={[styles.chip, isOwn ? styles.chipOwn : styles.chipOther]}>
      <Pressable
        accessibilityLabel={isPlaying ? "Pause voice memo" : "Play voice memo"}
        accessibilityRole="button"
        hitSlop={6}
        onPress={handleToggle}
        style={[styles.button, isOwn ? styles.buttonOwn : styles.buttonOther]}
      >
        <Ionicons
          color={isOwn ? hai.onyx : hai.paper}
          name={isPlaying ? "pause" : "play"}
          size={14}
        />
      </Pressable>
      <View style={styles.body}>
        <Text
          style={[styles.label, isOwn ? styles.labelOwn : styles.labelOther]}
        >
          Voice memo
        </Text>
        <Text
          style={[styles.meta, isOwn ? styles.metaOwn : styles.metaOther]}
        >
          {formatTime(isPlaying || elapsed > 0 ? elapsed : duration)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    gap: 1,
  },
  button: {
    alignItems: "center",
    borderRadius: 999,
    height: 28,
    justifyContent: "center",
    width: 28,
  },
  buttonOther: {
    backgroundColor: hai.basalt,
  },
  buttonOwn: {
    backgroundColor: hai.paper,
  },
  chip: {
    alignItems: "center",
    borderRadius: radii.card,
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  chipOther: {
    backgroundColor: hai.pebble,
  },
  chipOwn: {
    backgroundColor: "rgba(248,246,241,0.18)",
  },
  label: {
    ...typography.body,
    fontWeight: "600",
  },
  labelOther: {
    color: colors.onyx,
  },
  labelOwn: {
    color: hai.paper,
  },
  meta: {
    ...typography.monoMeta,
  },
  metaOther: {
    color: colors.slate,
  },
  metaOwn: {
    color: "rgba(248,246,241,0.7)",
  },
});

export default AudioPlayerChip;

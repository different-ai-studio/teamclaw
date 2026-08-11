import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { LayoutAnimation, Pressable, StyleSheet, Text, View } from "react-native";

import { StatusDot } from "../../../ui/atoms/StatusDot";
import { colors, hai, iosType, motion, spacing } from "../../../ui/theme";
import type { ToolCallPresentation, ToolResult } from "../tool-display";

export type ToolCallLineProps = {
  presentation: ToolCallPresentation;
  result?: ToolResult;
  timestamp?: string;
};

/**
 * A single tool call in the feed. Ports iOS `CompactToolLine`.
 *
 * Deliberately a line, not a card: a turn can run a dozen tools, and iOS keeps
 * each to one row — a 5pt status dot, the tool name in tracked uppercase mono,
 * and a one-line argument summary. Tapping expands the raw arguments; a result,
 * when one has arrived, gets its own RESULT disclosure below.
 *
 * Expo previously drew these as generic "TOOL CALL" note cards with three lines
 * of pre-joined text and no status at all, so a failed tool was
 * indistinguishable from one that succeeded.
 */
export function ToolCallLine({ presentation, result, timestamp }: ToolCallLineProps) {
  const [showArguments, setShowArguments] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const canExpand = presentation.summary !== null;

  const toggle = (set: (updater: (value: boolean) => boolean) => void) => () => {
    LayoutAnimation.configureNext({
      duration: motion.fast.duration,
      update: { type: LayoutAnimation.Types.easeInEaseOut },
      create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
      delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
    });
    set((value) => !value);
  };

  return (
    <View style={styles.container}>
      <Pressable
        accessibilityHint={canExpand ? "Tap to show arguments" : undefined}
        accessibilityLabel={`${presentation.label}, ${statusLabel(presentation.status)}`}
        accessibilityRole="button"
        disabled={!canExpand}
        onPress={toggle(setShowArguments)}
        style={styles.headerRow}
      >
        <ToolStatusDot status={presentation.status} />
        <Text numberOfLines={1} style={styles.toolName}>
          {presentation.label}
        </Text>
        {presentation.summary ? (
          <Text ellipsizeMode="middle" numberOfLines={1} style={styles.summary}>
            {presentation.summary}
          </Text>
        ) : null}
      </Pressable>

      {showArguments && presentation.summary ? (
        <View style={styles.detailRow}>
          <View style={styles.detailRule} />
          <Text numberOfLines={10} selectable style={styles.detailText}>
            {presentation.description}
          </Text>
        </View>
      ) : null}

      {result && result.summary ? (
        <>
          <Pressable
            accessibilityRole="button"
            onPress={toggle(setShowResult)}
            style={styles.resultHeaderRow}
          >
            <Text style={styles.resultEyebrow}>RESULT</Text>
            <View style={styles.resultSpacer} />
            <Ionicons
              color={colors.slate}
              name={showResult ? "chevron-down" : "chevron-forward"}
              size={9}
            />
          </Pressable>
          {showResult ? (
            <View style={styles.detailRow}>
              <View style={styles.detailRule} />
              <Text numberOfLines={20} selectable style={styles.detailText}>
                {result.summary}
              </Text>
            </View>
          ) : null}
        </>
      ) : null}

      {timestamp ? <Text style={styles.timestamp}>{timestamp}</Text> : null}
    </View>
  );
}

function statusLabel(status: ToolCallPresentation["status"]): string {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "unknown":
      return "status unknown";
  }
}

/**
 * iOS uses a 5pt circle here rather than the 8pt status dot elsewhere — a tool
 * line is denser than a row. Running breathes; the rest are static.
 */
function ToolStatusDot({ status }: { status: ToolCallPresentation["status"] }) {
  switch (status) {
    case "running":
      return <StatusDot breathing kind="active" size={5} />;
    case "completed":
      return <StatusDot breathing={false} kind="muted" size={5} />;
    case "failed":
      return <StatusDot breathing={false} kind="error" size={5} />;
    case "unknown":
      return <StatusDot breathing={false} color={hai.slate} size={5} style={styles.dotFaded} />;
  }
}

/** Dot 5 + gap 8 — lines the detail rule up under the tool name, as iOS does. */
const DETAIL_INSET = 13;

const styles = StyleSheet.create({
  container: {
    gap: 4,
    paddingHorizontal: spacing.lg,
    paddingVertical: 2,
  },
  detailRow: {
    flexDirection: "row",
    gap: 12,
    paddingLeft: DETAIL_INSET,
  },
  detailRule: {
    backgroundColor: colors.hairline,
    width: 0.5,
  },
  detailText: {
    color: colors.basalt,
    flex: 1,
    ...iosType.caption2Mono,
  },
  dotFaded: {
    opacity: 0.4,
  },
  headerRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  resultEyebrow: {
    color: colors.slate,
    letterSpacing: 2,
    ...iosType.caption2Mono,
    fontSize: 9,
  },
  resultHeaderRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    paddingLeft: DETAIL_INSET,
  },
  resultSpacer: {
    flex: 1,
  },
  summary: {
    color: colors.slate,
    flexShrink: 1,
    ...iosType.caption2,
  },
  timestamp: {
    color: colors.slate,
    paddingLeft: DETAIL_INSET,
    ...iosType.caption2,
  },
  toolName: {
    color: colors.basalt,
    letterSpacing: 1.5,
    ...iosType.caption2Mono,
    fontSize: 10,
  },
});

export default ToolCallLine;

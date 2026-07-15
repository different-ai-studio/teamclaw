import { Ionicons } from "@expo/vector-icons";
import * as Linking from "expo-linking";
import type { ComponentProps } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Hairline } from "../../../ui/atoms/Hairline";
import { SectionEyebrow } from "../../../ui/atoms/SectionEyebrow";
import { colors, hai, radii, spacing, typography } from "../../../ui/theme";

type IconName = ComponentProps<typeof Ionicons>["name"];

export type AttachmentSource = "files" | "camera" | "photos";

export type AttachmentDrawerSheetProps = {
  errorMessage?: string | null;
  onClose: () => void;
  onPickSource?: (source: AttachmentSource) => void;
};

type SourceRow = {
  label: string;
  helper: string;
  iconName: IconName;
  source: AttachmentSource;
};

const SOURCES: SourceRow[] = [
  {
    source: "files",
    label: "Files",
    helper: "Attach a document from the on-device file system.",
    iconName: "document-outline",
  },
  {
    source: "camera",
    label: "Camera",
    helper: "Take a photo or video right now.",
    iconName: "camera-outline",
  },
  {
    source: "photos",
    label: "Photos",
    helper: "Pick up to five images from the library.",
    iconName: "images-outline",
  },
];

/**
 * Mirrors iOS `AttachmentDrawerSheet`: a bottom modal that lists the
 * three attachment sources (Files / Camera / Photos). Real picker
 * integrations land in a follow-up — for now each row calls
 * `onPickSource` so callers can wire the in-flight expo-document-picker
 * / expo-image-picker calls without touching this presentation file.
 */
export function AttachmentDrawerSheet({
  errorMessage,
  onClose,
  onPickSource,
}: AttachmentDrawerSheetProps) {
  return (
    <View style={styles.screen}>
      <View style={styles.headerBar}>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>Attach</Text>
        <Pressable hitSlop={8} onPress={onClose} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </View>
      <Hairline />

      <View style={styles.body}>
        <SectionEyebrow label="SOURCE" style={styles.sectionEyebrow} />
        <View style={styles.card}>
          {SOURCES.map((row, index) => (
            <View key={row.source}>
              <Pressable
                accessibilityRole="button"
                disabled={!onPickSource}
                onPress={() => onPickSource?.(row.source)}
                style={({ pressed }) => [
                  styles.row,
                  pressed && onPickSource ? styles.rowPressed : null,
                ]}
              >
                <View style={styles.rowIcon}>
                  <Ionicons color={colors.cinnabar} name={row.iconName} size={20} />
                </View>
                <View style={styles.rowBody}>
                  <Text style={styles.rowLabel}>{row.label}</Text>
                  <Text style={styles.rowHelper}>{row.helper}</Text>
                </View>
                <Ionicons color={colors.slate} name="chevron-forward" size={16} />
              </Pressable>
              {index < SOURCES.length - 1 ? <Hairline /> : null}
            </View>
          ))}
        </View>

        {errorMessage ? (
          <View style={styles.errorBlock}>
            <Text style={styles.errorText}>{errorMessage}</Text>
            {/permission/i.test(errorMessage) ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  void Linking.openSettings();
                }}
                style={({ pressed }) => [
                  styles.openSettings,
                  pressed ? styles.openSettingsPressed : null,
                ]}
              >
                <Text style={styles.openSettingsText}>Open Settings</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  card: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  errorBlock: {
    gap: spacing.sm,
  },
  errorText: {
    color: hai.cinnabarDeep,
    paddingHorizontal: spacing.xs,
    ...typography.caption,
  },
  openSettings: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: "rgba(184,75,54,0.10)",
    borderRadius: radii.button,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  openSettingsPressed: {
    opacity: 0.7,
  },
  openSettingsText: {
    color: hai.cinnabar,
    ...typography.caption,
    fontWeight: "700",
  },
  footnote: {
    color: colors.slate,
    paddingHorizontal: spacing.xs,
    ...typography.caption,
  },
  headerBar: {
    alignItems: "center",
    backgroundColor: colors.mist,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 48,
    paddingHorizontal: spacing.xs,
  },
  headerSlot: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 40,
    minWidth: 40,
  },
  headerTitle: {
    color: colors.onyx,
    ...typography.sectionTitle,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowHelper: {
    color: colors.slate,
    ...typography.caption,
  },
  rowIcon: {
    alignItems: "center",
    backgroundColor: "rgba(184,75,54,0.08)",
    borderRadius: 14,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  rowLabel: {
    color: colors.onyx,
    ...typography.body,
    fontWeight: "600",
  },
  rowPressed: {
    backgroundColor: "rgba(34,32,29,0.04)",
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  sectionEyebrow: {
    paddingHorizontal: spacing.xs,
  },
});

export default AttachmentDrawerSheet;

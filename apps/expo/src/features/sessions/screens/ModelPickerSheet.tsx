import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Hairline } from "../../../ui/atoms/Hairline";
import { GlassHeader, GLASS_HEADER_HEIGHT } from "../../../ui/GlassHeader";
import { colors, hai, iosType, spacing } from "../../../ui/theme";

export type ModelPickerSheetProps = {
  agentName: string;
  currentModel: string | null;
  models: ReadonlyArray<{ id: string; displayName: string }>;
  onCancel: () => void;
  onSelect: (modelId: string) => void;
};

/**
 * The model list behind an agent row's trailing chip.
 *
 * iOS puts this in a SwiftUI `Menu` attached to the row — a popover of
 * `Button(model)` entries. React Native has no equivalent anchored menu, so the
 * same list is a sheet. What matters is that both offer the runtime's *reported*
 * models rather than free text: the daemon publishes `available_models` on the
 * retained runtime state, and a model it doesn't know is rejected.
 */
export function ModelPickerSheet({
  agentName,
  currentModel,
  models,
  onCancel,
  onSelect,
}: ModelPickerSheetProps) {
  const { t } = useTranslation();
  return (
    <View style={styles.screen}>
      <GlassHeader>
        <Pressable hitSlop={8} onPress={onCancel} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
        <Text numberOfLines={1} style={styles.headerTitle}>
          {agentName}
        </Text>
        <View style={styles.headerSlot} />
      </GlassHeader>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.caption}>
          {t("The model this runtime uses for its next turn.")}
        </Text>
        <View style={styles.card}>
          {models.map((model, index) => {
            const isCurrent = model.id === currentModel;
            return (
              <View key={model.id}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: isCurrent }}
                  onPress={() => onSelect(model.id)}
                  style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
                >
                  <View style={styles.rowText}>
                    <Text numberOfLines={1} style={styles.rowTitle}>
                      {model.displayName || model.id}
                    </Text>
                    {model.displayName && model.displayName !== model.id ? (
                      <Text numberOfLines={1} style={styles.rowSubtitle}>
                        {model.id}
                      </Text>
                    ) : null}
                  </View>
                  {isCurrent ? (
                    <Ionicons color={hai.cinnabar} name="checkmark" size={18} />
                  ) : null}
                </Pressable>
                {index < models.length - 1 ? <Hairline /> : null}
              </View>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  caption: {
    color: colors.basalt,
    paddingHorizontal: spacing.lg,
    ...iosType.footnote,
  },
  card: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  content: {
    gap: spacing.md,
    paddingBottom: spacing.xxxl,
    paddingTop: GLASS_HEADER_HEIGHT + spacing.md,
  },
  headerSlot: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 40,
    minWidth: 40,
  },
  headerTitle: {
    color: colors.onyx,
    flexShrink: 1,
    ...iosType.headline,
  },
  pressed: {
    backgroundColor: colors.mist,
  },
  row: {
    alignItems: "center",
    backgroundColor: colors.paper,
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
  },
  rowSubtitle: {
    color: colors.slate,
    ...iosType.caption2Mono,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    color: colors.onyx,
    ...iosType.body,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
});

export default ModelPickerSheet;

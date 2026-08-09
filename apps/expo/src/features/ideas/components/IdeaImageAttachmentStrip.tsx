import { Ionicons } from "@expo/vector-icons";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";

import { colors, hai, radii, spacing, typography } from "../../../ui/theme";

/**
 * Horizontal strip of picked-but-not-yet-posted idea images, ported from the
 * iOS `IdeaImageAttachmentStrip`. Shows per-thumb upload progress, a failure
 * badge, a remove affordance, and (when `onAdd` is supplied) a trailing "add"
 * tile — the create sheet uses that, the progress composer keeps its own "+".
 */

export type ComposerAttachmentState = "uploading" | "uploaded" | "failed";

export type ComposerAttachment = {
  id: string;
  localUri: string;
  remoteUrl: string | null;
  state: ComposerAttachmentState;
};

export type IdeaImageAttachmentStripProps = {
  attachments: ReadonlyArray<ComposerAttachment>;
  onAdd?: () => void;
  onRemove: (id: string) => void;
};

export function IdeaImageAttachmentStrip({
  attachments,
  onAdd,
  onRemove,
}: IdeaImageAttachmentStripProps) {
  if (attachments.length === 0 && !onAdd) return null;
  return (
    <View style={styles.strip}>
      {attachments.map((attachment) => (
        <View key={attachment.id} style={styles.item}>
          <Image
            resizeMode="cover"
            source={{ uri: attachment.localUri }}
            style={styles.image}
          />
          {attachment.state === "uploading" ? (
            <View style={styles.overlay}>
              <ActivityIndicator color={hai.paper} size="small" />
            </View>
          ) : null}
          {attachment.state === "failed" ? (
            <View style={styles.overlay}>
              <Ionicons color={hai.paper} name="alert-circle" size={18} />
            </View>
          ) : null}
          <Pressable
            accessibilityLabel="Remove image"
            accessibilityRole="button"
            hitSlop={6}
            onPress={() => onRemove(attachment.id)}
            style={styles.remove}
          >
            <Ionicons color={hai.paper} name="close" size={12} />
          </Pressable>
        </View>
      ))}
      {onAdd ? (
        <Pressable
          accessibilityLabel="Add image"
          accessibilityRole="button"
          onPress={onAdd}
          style={({ pressed }) => [styles.addTile, pressed ? styles.pressed : null]}
        >
          <Ionicons color={colors.slate} name="add" size={20} />
          <Text style={styles.addTileText}>Image</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  addTile: {
    alignItems: "center",
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderStyle: "dashed",
    borderWidth: 1,
    gap: 2,
    height: 56,
    justifyContent: "center",
    width: 56,
  },
  addTileText: {
    color: colors.slate,
    ...typography.caption,
  },
  image: {
    height: "100%",
    width: "100%",
  },
  item: {
    borderRadius: radii.card,
    height: 56,
    overflow: "hidden",
    position: "relative",
    width: 56,
  },
  overlay: {
    alignItems: "center",
    backgroundColor: "rgba(34,32,29,0.45)",
    bottom: 0,
    justifyContent: "center",
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  pressed: {
    opacity: 0.7,
  },
  remove: {
    alignItems: "center",
    backgroundColor: "rgba(34,32,29,0.65)",
    borderRadius: 9,
    height: 18,
    justifyContent: "center",
    position: "absolute",
    right: 2,
    top: 2,
    width: 18,
  },
  strip: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
  },
});

export default IdeaImageAttachmentStrip;

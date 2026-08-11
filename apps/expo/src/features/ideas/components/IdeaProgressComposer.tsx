import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { colors, hai, radii, shadows, spacing, typography } from "../../../ui/theme";
import type { IdeaImageSource } from "../idea-image-attachments";
import {
  IdeaImageAttachmentStrip,
  type ComposerAttachment,
} from "./IdeaImageAttachmentStrip";

/**
 * Bottom composer on the idea detail screen, ported from the iOS
 * `IdeaDetailView.composerArea`: an attachment strip that only appears once
 * something is selected, then a capsule with an "add image" affordance, the
 * text field, and Submit.
 *
 * Submit stays disabled while any attachment is still uploading or has failed,
 * matching iOS `canSubmitProgress`.
 */

export type IdeaProgressComposerProps = {
  attachments: ReadonlyArray<ComposerAttachment>;
  isSubmitting: boolean;
  onAddImage: (source: IdeaImageSource) => void;
  onRemoveAttachment: (id: string) => void;
  onSubmit: (text: string) => void;
};

export function canSubmitProgress(
  text: string,
  attachments: ReadonlyArray<ComposerAttachment>,
  isSubmitting: boolean,
): boolean {
  if (isSubmitting) return false;
  if (attachments.some((a) => a.state === "uploading" || a.state === "failed")) return false;
  const uploaded = attachments.filter((a) => a.state === "uploaded" && a.remoteUrl);
  return text.trim().length > 0 || uploaded.length > 0;
}

export function IdeaProgressComposer({
  attachments,
  isSubmitting,
  onAddImage,
  onRemoveAttachment,
  onSubmit,
}: IdeaProgressComposerProps) {
  const [text, setText] = useState("");
  const canSubmit = canSubmitProgress(text, attachments, isSubmitting);

  const promptForSource = () => {
    const labels = ["Photo Library", "Camera", "Cancel"];
    const dispatch = (index: number) => {
      if (index === 0) onAddImage("library");
      else if (index === 1) onAddImage("camera");
    };
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: labels, cancelButtonIndex: 2 },
        dispatch,
      );
      return;
    }
    Alert.alert("Add image", undefined, [
      { text: labels[0], onPress: () => dispatch(0) },
      { text: labels[1], onPress: () => dispatch(1) },
      { text: labels[2], style: "cancel" },
    ]);
  };

  return (
    <View style={styles.composerArea}>
      {attachments.length > 0 ? (
        <View style={styles.strip}>
          <IdeaImageAttachmentStrip attachments={attachments} onRemove={onRemoveAttachment} />
        </View>
      ) : null}

      <View style={styles.capsule}>
        <Pressable
          accessibilityLabel="Add image"
          accessibilityRole="button"
          disabled={isSubmitting}
          hitSlop={6}
          onPress={promptForSource}
          style={({ pressed }) => [styles.addButton, pressed ? styles.pressed : null]}
        >
          <Ionicons color={hai.basalt} name="add" size={20} />
        </Pressable>

        <TextInput
          editable={!isSubmitting}
          multiline
          onChangeText={setText}
          placeholder="Submit progress, or @mention an agent…"
          placeholderTextColor={colors.slate}
          selectionColor={colors.cinnabar}
          style={styles.input}
          value={text}
        />

        <Pressable
          accessibilityRole="button"
          disabled={!canSubmit}
          onPress={() => {
            if (!canSubmit) return;
            onSubmit(text);
            setText("");
          }}
          style={[styles.submit, canSubmit ? null : styles.submitDisabled]}
        >
          {isSubmitting ? (
            <ActivityIndicator color={hai.mist} size="small" />
          ) : (
            <Text style={styles.submitText}>Submit</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  addButton: {
    alignItems: "center",
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  capsule: {
    alignItems: "flex-end",
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.sm,
    padding: 6,
    ...shadows.composer,
  },
  composerArea: {
    gap: 6,
  },
  input: {
    color: colors.onyx,
    flex: 1,
    maxHeight: 96,
    paddingBottom: 6,
    paddingLeft: 2,
    paddingTop: 6,
    ...typography.secondaryBody,
  },
  pressed: {
    opacity: 0.7,
  },
  strip: {
    paddingHorizontal: 2,
  },
  submit: {
    alignItems: "center",
    backgroundColor: hai.onyx,
    borderRadius: radii.pill,
    height: 30,
    justifyContent: "center",
    width: 62,
  },
  submitDisabled: {
    opacity: 0.4,
  },
  submitText: {
    color: hai.mist,
    ...typography.caption,
    fontWeight: "600",
  },
});

export type { ComposerAttachment, IdeaImageSource };

export default IdeaProgressComposer;

import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { useOnboarding } from "../_layout";
import { Hairline } from "../../src/ui/atoms/Hairline";
import { SectionEyebrow } from "../../src/ui/atoms/SectionEyebrow";
import { createWorkspacesApi } from "../../src/features/workspaces/workspace-api";
import { createIdeasApi } from "../../src/features/ideas/idea-api";
import { supabaseAccessToken } from "../../src/lib/cloud-api/client";
import { supabase } from "../../src/lib/supabase/client";
import { colors, hai, radii, spacing, typography } from "../../src/ui/theme";

export default function NewIdeaRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const teamId = state.currentTeam?.id ?? "";
  const memberActorId = state.currentMemberActorId;

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>([]);
  const [pickedWorkspaceId, setPickedWorkspaceId] = useState<string | null>(null);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await createWorkspacesApi({
          getAccessToken: supabaseAccessToken(supabase),
        }).list(teamId);
        if (cancelled) return;
        setWorkspaces(
          rows
            .filter((row) => !row.archived)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((row) => ({ id: row.id, name: row.name })),
        );
      } catch {
        if (!cancelled) setWorkspaces([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  const workspaceLabel =
    pickedWorkspaceId === null
      ? "None"
      : workspaces.find((w) => w.id === pickedWorkspaceId)?.name ?? "—";

  const showWorkspacePicker = () => {
    const labels = ["None", ...workspaces.map((w) => w.name), "Cancel"];
    const dispatch = (index: number) => {
      if (index === 0) setPickedWorkspaceId(null);
      else if (index > 0 && index <= workspaces.length) {
        setPickedWorkspaceId(workspaces[index - 1].id);
      }
    };
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: labels, cancelButtonIndex: labels.length - 1 },
        dispatch,
      );
      return;
    }
    Alert.alert(
      "Link workspace",
      undefined,
      labels.map((label, index) => {
        if (index === labels.length - 1) {
          return { text: label, style: "cancel" as const };
        }
        return { text: label, onPress: () => dispatch(index) };
      }),
    );
  };

  const canCreate =
    !isBusy && Boolean(teamId) && Boolean(memberActorId) && title.trim().length > 0;

  const handleCreate = async () => {
    if (!canCreate) return;
    setIsBusy(true);
    setError(null);
    try {
      const idea = await createIdeasApi({
        getAccessToken: supabaseAccessToken(supabase),
      }).createIdea({
        teamId,
        title: title.trim(),
        description: description.trim(),
        workspaceId: pickedWorkspaceId,
      });
      router.back();
      if (idea.ideaId) {
        router.push(`/(app)/idea-detail?ideaId=${idea.ideaId}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create idea.");
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.headerBar}>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>New Idea</Text>
        <Pressable hitSlop={8} onPress={() => router.back()} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </View>
      <Hairline />

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.section}>
          <SectionEyebrow label="TITLE" style={styles.sectionEyebrow} />
          <View style={styles.card}>
            <TextInput
              autoCapitalize="sentences"
              autoCorrect={true}
              editable={!isBusy}
              maxLength={120}
              onChangeText={setTitle}
              placeholder="Sum up the idea in a sentence"
              placeholderTextColor={colors.slate}
              selectionColor={colors.cinnabar}
              style={styles.titleInput}
              value={title}
            />
          </View>
        </View>

        {workspaces.length > 0 ? (
          <View style={styles.section}>
            <SectionEyebrow label="WORKSPACE" style={styles.sectionEyebrow} />
            <Pressable
              accessibilityRole="button"
              onPress={showWorkspacePicker}
              style={({ pressed }) => [
                styles.card,
                styles.pickerRow,
                pressed ? styles.pickerRowPressed : null,
              ]}
            >
              <Text
                numberOfLines={1}
                style={[
                  styles.pickerValue,
                  pickedWorkspaceId === null ? styles.pickerValueMuted : null,
                ]}
              >
                {workspaceLabel}
              </Text>
              <Ionicons color={colors.slate} name="chevron-down" size={14} />
            </Pressable>
          </View>
        ) : null}

        <View style={styles.section}>
          <SectionEyebrow label="DESCRIPTION" style={styles.sectionEyebrow} />
          <View style={styles.card}>
            <TextInput
              editable={!isBusy}
              multiline
              onChangeText={setDescription}
              placeholder="What does it look like? Who's it for?"
              placeholderTextColor={colors.slate}
              selectionColor={colors.cinnabar}
              style={styles.descriptionInput}
              value={description}
            />
          </View>
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <Pressable
          accessibilityRole="button"
          disabled={!canCreate}
          onPress={handleCreate}
          style={({ pressed }) => [
            styles.cta,
            canCreate ? styles.ctaActive : styles.ctaInactive,
            pressed && canCreate ? styles.ctaPressed : null,
          ]}
        >
          {isBusy ? (
            <ActivityIndicator color={hai.paper} />
          ) : (
            <Text
              style={[styles.ctaText, canCreate ? styles.ctaTextActive : styles.ctaTextInactive]}
            >
              Create idea
            </Text>
          )}
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
  },
  content: {
    gap: spacing.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  cta: {
    alignItems: "center",
    borderRadius: radii.button,
    paddingVertical: 14,
  },
  ctaActive: {
    backgroundColor: hai.cinnabar,
  },
  ctaInactive: {
    backgroundColor: hai.pebble,
  },
  ctaPressed: {
    opacity: 0.88,
  },
  ctaText: {
    ...typography.cardTitle,
  },
  ctaTextActive: {
    color: hai.paper,
  },
  ctaTextInactive: {
    color: hai.slate,
  },
  descriptionInput: {
    color: colors.onyx,
    minHeight: 96,
    padding: 0,
    textAlignVertical: "top",
    ...typography.body,
  },
  errorText: {
    color: hai.cinnabarDeep,
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
  pickerRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "space-between",
  },
  pickerRowPressed: {
    opacity: 0.8,
  },
  pickerValue: {
    color: colors.onyx,
    flex: 1,
    ...typography.body,
  },
  pickerValueMuted: {
    color: colors.slate,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  section: {
    gap: spacing.sm,
  },
  sectionEyebrow: {
    paddingHorizontal: spacing.xs,
  },
  titleInput: {
    color: colors.onyx,
    padding: 0,
    ...typography.cardTitle,
  },
});

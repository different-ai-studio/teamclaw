import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { PrimaryButton } from "../../../ui/button";
import { AppCard } from "../../../ui/card";
import { AppInput } from "../../../ui/input";
import { colors, spacing, typography } from "../../../ui/theme";

type CreateTeamScreenProps = {
  errorMessage: string | null;
  isAnonymous: boolean;
  isBusy: boolean;
  onCreateTeam: (name: string) => Promise<void>;
};

export function CreateTeamScreen({
  errorMessage,
  isAnonymous,
  isBusy,
  onCreateTeam,
}: CreateTeamScreenProps) {
  const [teamName, setTeamName] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [isServerErrorDismissed, setIsServerErrorDismissed] = useState(false);

  const submit = async () => {
    const nextName = teamName.trim();
    if (nextName.length < 2) {
      setLocalError("Give the team a name with at least 2 characters.");
      return;
    }

    setLocalError(null);
    setIsServerErrorDismissed(false);

    try {
      await onCreateTeam(nextName);
    } catch {}
  };

  const visibleError =
    localError ?? (isServerErrorDismissed ? null : errorMessage);

  return (
    <KeyboardAvoidingView
      behavior={Platform.select({ ios: "padding", default: undefined })}
      style={styles.screen}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={styles.title}>Create your first team</Text>
          <Text style={styles.body}>
            Pick a name for the shared workspace. You can refine the rest of the setup once
            you land in the app shell.
          </Text>
        </View>

        <AppCard elevated style={styles.card}>
          <AppInput
            editable={!isBusy}
            label="Team name"
            onChangeText={(value) => {
              setTeamName(value);
              if (localError) {
                setLocalError(null);
              }
              if (errorMessage) {
                setIsServerErrorDismissed(true);
              }
            }}
            placeholder="Editorial Ops"
            value={teamName}
          />

          {visibleError ? <Text style={styles.error}>{visibleError}</Text> : null}

          <PrimaryButton
            isLoading={isBusy}
            label="Create team"
            onPress={() => {
              void submit();
            }}
          />
        </AppCard>

        <AppCard compact style={styles.noteCard}>
          <Text style={styles.noteTitle}>{isAnonymous ? "Guest session" : "Signed-in account"}</Text>
          <Text style={styles.noteBody}>
            {isAnonymous
              ? "This workspace will be attached to your current guest session until you upgrade it."
              : "Your account is ready. This step creates the first shared space for your team."}
          </Text>
        </AppCard>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  body: {
    color: colors.ink2,
    ...typography.body,
  },
  card: {
    gap: spacing.md,
  },
  content: {
    gap: spacing.lg,
    padding: spacing.xxl,
  },
  error: {
    color: colors.danger,
    ...typography.caption,
  },
  header: {
    gap: spacing.sm,
  },
  noteBody: {
    color: colors.ink2,
    ...typography.secondaryBody,
  },
  noteCard: {
    gap: spacing.xs,
  },
  noteTitle: {
    color: colors.foreground,
    ...typography.cardTitle,
  },
  screen: {
    backgroundColor: colors.background,
    flex: 1,
  },
  title: {
    color: colors.foreground,
    ...typography.sectionTitle,
  },
});

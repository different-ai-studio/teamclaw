import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
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
  isBusy: boolean;
  onCreateTeam: (name: string) => Promise<void>;
  onSignOut: () => Promise<void>;
};

export function CreateTeamScreen({
  errorMessage,
  isBusy,
  onCreateTeam,
  onSignOut,
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
    } catch {
      // `createTeam` calls finishWithError before rethrowing, so the message
      // is already bound to `errorMessage` and rendered as `visibleError`.
    }
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
          <Text style={styles.noteTitle}>Signed-in account</Text>
          <Text style={styles.noteBody}>
            Your account is ready. This step creates the first shared space for
            your team.
          </Text>
        </AppCard>

        {/*
          The only way out. Being signed in with no team routes straight back
          here, so without this the screen is a dead end — you cannot even
          switch accounts. iOS offers the same escape from its onboarding error
          state (`Button("Sign Out", role: .destructive)`).
        */}
        <Pressable
          accessibilityRole="button"
          disabled={isBusy}
          onPress={() => {
            void onSignOut();
          }}
          style={({ pressed }) => [
            styles.signOut,
            pressed && !isBusy ? styles.signOutPressed : null,
          ]}
          testID="createTeam.signOutButton"
        >
          <Text style={styles.signOutLabel}>Sign out</Text>
        </Pressable>
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
  signOut: {
    alignItems: "center",
    paddingVertical: spacing.sm,
  },
  signOutLabel: {
    color: colors.danger,
    ...typography.body,
    fontWeight: "600",
  },
  signOutPressed: {
    opacity: 0.6,
  },
  title: {
    color: colors.foreground,
    ...typography.sectionTitle,
  },
});

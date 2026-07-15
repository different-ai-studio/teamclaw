import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { Hairline } from "../../../ui/atoms/Hairline";
import { colors, radii, shadows, spacing, typography } from "../../../ui/theme";
import { parseInviteToken } from "../invite-api";

export type ChooseAuthScreenProps = {
  errorMessage?: string | null;
  isBusy?: boolean;
  onCreatePrivateWorkspace: () => void;
  onSignInOrRegister: () => void;
  onJoinWithToken: (token: string) => void | Promise<void>;
};

/**
 * The "set up TeamClaw" three-path picker — private workspace / sign-in /
 * invite token. Mirrors `apps/ios/.../ChooseAuthView.swift`:
 *   - Private workspace: anonymous sign-in, auto-create a solo team
 *   - Sign in or register: go to the existing email OTP screen
 *   - Join a team: open InviteJoinSheet, paste link, claim invite
 */
export function ChooseAuthScreen({
  errorMessage,
  isBusy = false,
  onCreatePrivateWorkspace,
  onSignInOrRegister,
  onJoinWithToken,
}: ChooseAuthScreenProps) {
  const [inviteOpen, setInviteOpen] = useState(false);

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>Set up Teamclaw</Text>
        <Text style={styles.subtitle}>
          Create your workspace or join the team that already works with your AI
          allies.
        </Text>
      </View>

      <View style={styles.actions}>
        <ActionRow
          caption="Start with an AI digital employee. No email needed."
          disabled={isBusy}
          icon="sparkles"
          isPrimary
          onPress={onCreatePrivateWorkspace}
          testID="choose.anonymousButton"
          title="Create a private workspace"
        />
        <ActionRow
          caption="Use email, Apple, or Google to sync across devices."
          disabled={isBusy}
          icon="mail-outline"
          onPress={onSignInOrRegister}
          testID="choose.signInButton"
          title="Sign in or register"
        />
        <ActionRow
          caption="Paste an invite link from a teammate."
          disabled={isBusy}
          icon="link-outline"
          onPress={() => setInviteOpen(true)}
          title="Join a team"
        />
      </View>

      {errorMessage ? (
        <Text style={styles.error}>{errorMessage}</Text>
      ) : null}

      <Modal
        animationType="slide"
        onRequestClose={() => setInviteOpen(false)}
        presentationStyle="pageSheet"
        visible={inviteOpen}
      >
        <InviteJoinSheet
          errorMessage={errorMessage ?? null}
          isBusy={isBusy}
          onCancel={() => setInviteOpen(false)}
          onSubmit={async (token) => {
            await onJoinWithToken(token);
          }}
        />
      </Modal>
    </View>
  );
}

type ActionRowProps = {
  caption: string;
  disabled?: boolean;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  isPrimary?: boolean;
  onPress: () => void;
  testID?: string;
  title: string;
};

function ActionRow({
  caption,
  disabled,
  icon,
  isPrimary,
  onPress,
  testID,
  title,
}: ActionRowProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        isPrimary ? styles.rowPrimary : styles.rowSecondary,
        pressed && !disabled ? styles.rowPressed : null,
      ]}
      testID={testID}
    >
      <View
        style={[
          styles.iconWrap,
          isPrimary ? styles.iconWrapPrimary : styles.iconWrapSecondary,
        ]}
      >
        <Ionicons
          color={isPrimary ? colors.paper : colors.basalt}
          name={icon}
          size={16}
        />
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowCaption}>{caption}</Text>
      </View>
      <Ionicons color={colors.slate} name="chevron-forward" size={14} />
    </Pressable>
  );
}

function InviteJoinSheet({
  errorMessage,
  isBusy,
  onCancel,
  onSubmit,
}: {
  errorMessage: string | null;
  isBusy: boolean;
  onCancel: () => void;
  onSubmit: (token: string) => void | Promise<void>;
}) {
  const [raw, setRaw] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const visibleError = localError ?? errorMessage;

  const submit = () => {
    const trimmed = raw.trim();
    if (!trimmed) {
      setLocalError("Paste an invite link or token first.");
      return;
    }
    // Accept either a full `teamclaw://invite?token=...` link or a bare token.
    const parsed = parseInviteToken(trimmed) ?? trimmed;
    if (!parsed) {
      setLocalError("Couldn't read a token from that link.");
      return;
    }
    setLocalError(null);
    void onSubmit(parsed);
  };

  return (
    <View style={styles.sheet}>
      <View style={styles.sheetHeader}>
        <Text style={styles.sheetTitle}>Join with invite link</Text>
        <Pressable
          accessibilityLabel="Cancel"
          accessibilityRole="button"
          hitSlop={8}
          onPress={onCancel}
        >
          <Ionicons color={colors.onyx} name="close" size={24} />
        </Pressable>
      </View>
      <Hairline />
      <View style={styles.sheetBody}>
        <Text style={styles.sheetCaption}>
          Paste the link your teammate shared. Teamclaw will sign you in and add
          you to their team.
        </Text>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isBusy}
          multiline
          numberOfLines={3}
          onChangeText={(value) => {
            setRaw(value);
            if (localError) setLocalError(null);
          }}
          placeholder="teamclaw://invite?token=… or just the token"
          placeholderTextColor={colors.slate}
          selectionColor={colors.cinnabar}
          style={styles.sheetInput}
          value={raw}
        />
        {visibleError ? (
          <View style={styles.sheetErrorBanner}>
            <Ionicons color={colors.cinnabar} name="warning" size={16} />
            <Text style={styles.sheetErrorText}>{visibleError}</Text>
          </View>
        ) : null}
        <Pressable
          accessibilityRole="button"
          disabled={isBusy || raw.trim().length === 0}
          onPress={submit}
          style={({ pressed }) => [
            styles.sheetSubmit,
            isBusy || raw.trim().length === 0
              ? styles.sheetSubmitDisabled
              : null,
            pressed ? styles.rowPressed : null,
          ]}
        >
          <Text style={styles.sheetSubmitLabel}>
            {isBusy ? "Joining…" : "Continue"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
  },
  error: {
    color: colors.cinnabarDeep,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    textAlign: "center",
    ...typography.caption,
  },
  header: {
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xxxl + spacing.lg,
  },
  iconWrap: {
    alignItems: "center",
    borderRadius: 10,
    height: 38,
    justifyContent: "center",
    width: 38,
  },
  iconWrapPrimary: {
    backgroundColor: colors.cinnabar,
  },
  iconWrapSecondary: {
    backgroundColor: colors.pebble,
  },
  row: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 13,
    padding: spacing.md,
  },
  rowBody: {
    flex: 1,
    gap: 4,
  },
  rowCaption: {
    color: colors.basalt,
    ...typography.caption,
  },
  rowPressed: {
    opacity: 0.85,
  },
  rowPrimary: {
    ...shadows.card,
  },
  rowSecondary: {
    backgroundColor: "rgba(248,246,241,0.85)",
  },
  rowTitle: {
    color: colors.onyx,
    ...typography.body,
    fontWeight: "600",
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  sheet: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  sheetBody: {
    gap: spacing.md,
    padding: spacing.xl,
  },
  sheetCaption: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  sheetErrorBanner: {
    alignItems: "center",
    backgroundColor: "rgba(184,75,54,0.10)",
    borderRadius: radii.card,
    flexDirection: "row",
    gap: 6,
    padding: spacing.sm,
  },
  sheetErrorText: {
    color: colors.onyx,
    flex: 1,
    ...typography.caption,
  },
  sheetHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  sheetInput: {
    backgroundColor: colors.pebble,
    borderRadius: radii.card,
    color: colors.onyx,
    minHeight: 80,
    padding: spacing.md,
    textAlignVertical: "top",
    ...typography.body,
  },
  sheetSubmit: {
    alignItems: "center",
    backgroundColor: colors.cinnabar,
    borderRadius: radii.button,
    paddingVertical: 14,
  },
  sheetSubmitDisabled: {
    opacity: 0.45,
  },
  sheetSubmitLabel: {
    color: colors.paper,
    ...typography.cardTitle,
  },
  sheetTitle: {
    color: colors.onyx,
    ...typography.sectionTitle,
  },
  title: {
    color: colors.onyx,
    ...typography.display,
    fontSize: 32,
    lineHeight: 38,
  },
  subtitle: {
    color: colors.basalt,
    ...typography.body,
  },
});

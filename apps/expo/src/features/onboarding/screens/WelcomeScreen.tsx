import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { PrimaryButton } from "../../../ui/button";
import { Hairline } from "../../../ui/atoms/Hairline";
import { StatusDot, type StatusDotKind } from "../../../ui/atoms/StatusDot";
import { SheetModal } from "../../../ui/SheetModal";
import { colors, radii, spacing, typography } from "../../../ui/theme";
import { ServerSettingsSheet } from "./ServerSettingsSheet";

type WelcomeScreenProps = {
  onGetStarted: () => void;
  errorMessage?: string | null;
  /** Rebuild the Cloud API stack after a custom-server save (mirrors iOS). */
  onServerChanged?: () => void | Promise<void>;
};

type RoleCard = {
  id: string;
  title: string;
  status: StatusDotKind;
};

const ROLES: RoleCard[] = [
  { id: "sales", title: "Sales", status: "error" },
  { id: "support", title: "Support", status: "active" },
  { id: "ops", title: "Ops", status: "muted" },
];

export function WelcomeScreen({
  onGetStarted,
  errorMessage,
  onServerChanged,
}: WelcomeScreenProps) {
  const [serverOpen, setServerOpen] = useState(false);

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <View style={styles.toolbarSpacer} />
        <Pressable
          accessibilityLabel="Server settings"
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => setServerOpen(true)}
          style={({ pressed }) => [
            styles.serverButton,
            pressed ? styles.serverButtonPressed : null,
          ]}
          testID="welcome.serverSettingsButton"
        >
          <Ionicons color={colors.slate} name="globe-outline" size={22} />
        </Pressable>
      </View>

      <View style={styles.hero}>
        <RoleCardsRow />
        <Text style={styles.title}>TeamClu</Text>
        <View style={styles.copyBlock}>
          <Text style={styles.body}>AI digital employees</Text>
          <Text style={styles.body}>for every role.</Text>
        </View>
        <Text style={styles.tagline}>Your Ally. Together.</Text>
      </View>

      {errorMessage ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{errorMessage}</Text>
        </View>
      ) : null}

      <View style={styles.actions}>
        <PrimaryButton label="Get Started" onPress={onGetStarted} />
      </View>

      <SheetModal
        onRequestClose={() => setServerOpen(false)}
        visible={serverOpen}
      >
        <ServerSettingsSheet
          onCancel={() => setServerOpen(false)}
          onSaved={async () => {
            setServerOpen(false);
            await onServerChanged?.();
          }}
        />
      </SheetModal>
    </View>
  );
}

function RoleCardsRow() {
  return (
    <View style={styles.rolesRow}>
      {ROLES.map((role) => (
        <View key={role.id} style={styles.roleCard}>
          <View style={styles.roleHeader}>
            <StatusDot kind={role.status} size={9} />
            <Text style={styles.roleTitle}>{role.title}</Text>
          </View>
          <View style={styles.rolePlaceholder}>
            <Hairline style={styles.placeholderTop} />
            <Hairline style={styles.placeholderBottom} />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    paddingBottom: spacing.xxxl + spacing.lg,
    paddingHorizontal: spacing.xxl,
  },
  body: {
    color: colors.basalt,
    textAlign: "center",
    ...typography.body,
  },
  copyBlock: {
    alignItems: "center",
    gap: 2,
    marginTop: spacing.lg,
    paddingHorizontal: spacing.xxxl,
  },
  errorBanner: {
    backgroundColor: colors.pebble,
    borderRadius: radii.button,
    marginBottom: spacing.md,
    marginHorizontal: spacing.xxl,
    padding: spacing.md,
  },
  errorText: {
    color: colors.onyx,
    ...typography.caption,
  },
  hero: {
    alignItems: "center",
    flex: 1,
    gap: spacing.md,
    justifyContent: "center",
  },
  placeholderBottom: {
    backgroundColor: colors.slate,
    height: 5,
    opacity: 0.45,
    width: 42,
  },
  placeholderTop: {
    backgroundColor: colors.basalt,
    height: 5,
    opacity: 0.55,
    width: 62,
  },
  roleCard: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.panel,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 9,
    height: 76,
    paddingHorizontal: 12,
    paddingVertical: 12,
    width: 104,
  },
  roleHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 7,
  },
  rolePlaceholder: {
    gap: 5,
  },
  roleTitle: {
    color: colors.onyx,
    fontSize: 11,
    fontWeight: "600",
  },
  rolesRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  toolbar: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  toolbarSpacer: {
    flex: 1,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  serverButton: {
    padding: spacing.sm,
  },
  serverButtonPressed: {
    opacity: 0.6,
  },
  tagline: {
    color: colors.slate,
    marginTop: 2,
    ...typography.caption,
    fontWeight: "500",
  },
  title: {
    color: colors.onyx,
    ...typography.display,
    fontSize: 44,
    lineHeight: 48,
  },
});

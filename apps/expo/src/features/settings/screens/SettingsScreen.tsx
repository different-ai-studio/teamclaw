import { Ionicons } from "@expo/vector-icons";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";

import { Hairline } from "../../../ui/atoms/Hairline";
import { SectionEyebrow } from "../../../ui/atoms/SectionEyebrow";
import { colors, hai, radii, spacing, typography } from "../../../ui/theme";

export type SettingsTeam = {
  id?: string;
  name: string;
  role: string | null;
};

export type SettingsScreenProps = {
  appVersion: string;
  buildNumber: string;
  displayName: string;
  isAnonymous?: boolean;
  isSigningOut?: boolean;
  notificationsEnabled?: boolean;
  onClose: () => void;
  onEditProfile?: () => void;
  onOpenNotifications?: () => void;
  onOpenTeams?: () => void;
  onOpenWorkspaces?: () => void;
  onSignOut?: () => void;
  onToggleNotifications?: (enabled: boolean) => void;
  onUpgrade?: () => void;
  team: SettingsTeam | null;
  userEmail: string | null;
};

function avatarInitials(name: string): string {
  const parts = name
    .split(/[\s·]+/)
    .filter(Boolean)
    .slice(0, 2);
  if (parts.length === 0) return name.slice(0, 1).toUpperCase();
  return parts.map((p) => p.charAt(0).toUpperCase()).join("");
}

export function SettingsScreen({
  appVersion,
  buildNumber,
  displayName,
  isAnonymous = false,
  isSigningOut = false,
  notificationsEnabled = false,
  onClose,
  onEditProfile,
  onOpenNotifications,
  onOpenTeams,
  onOpenWorkspaces,
  onSignOut,
  onToggleNotifications,
  onUpgrade,
  team,
  userEmail,
}: SettingsScreenProps) {
  return (
    <View style={styles.screen}>
      <View style={styles.headerBar}>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>Settings</Text>
        <Pressable hitSlop={8} onPress={onClose} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </View>
      <Hairline />

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      >
        <Pressable
          accessibilityRole={onEditProfile ? "button" : undefined}
          disabled={!onEditProfile}
          onPress={onEditProfile}
          style={({ pressed }) => [
            styles.identityCard,
            pressed && onEditProfile ? styles.identityCardPressed : null,
          ]}
        >
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{avatarInitials(displayName)}</Text>
          </View>
          <View style={styles.identityBody}>
            <Text numberOfLines={1} style={styles.identityName}>
              {displayName}
            </Text>
            {userEmail ? (
              <Text numberOfLines={1} style={styles.identityEmail}>
                {userEmail}
              </Text>
            ) : null}
          </View>
          {onEditProfile ? (
            <Ionicons color={colors.slate} name="chevron-forward" size={18} />
          ) : null}
        </Pressable>

        {isAnonymous && onUpgrade ? (
          <Pressable
            accessibilityRole="button"
            onPress={onUpgrade}
            style={({ pressed }) => [
              styles.upgradeBanner,
              pressed ? styles.upgradeBannerPressed : null,
            ]}
          >
            <Ionicons
              color={hai.cinnabar}
              name="shield-checkmark-outline"
              size={22}
            />
            <View style={styles.upgradeBody}>
              <Text style={styles.upgradeTitle}>Upgrade your account</Text>
              <Text style={styles.upgradeHelper}>
                You're signed in anonymously. Attach email, Apple, or Google so
                you don't lose this workspace.
              </Text>
            </View>
            <Ionicons color={colors.slate} name="chevron-forward" size={16} />
          </Pressable>
        ) : null}

        {team ? (
          <View style={styles.section}>
            <SectionEyebrow label="TEAM" style={styles.sectionEyebrow} />
            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Name</Text>
                <Text style={styles.rowValue}>{team.name}</Text>
              </View>
              <Hairline />
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Role</Text>
                <Text style={styles.rowValue}>{team.role ?? "member"}</Text>
              </View>
              {team.id ? (
                <>
                  <Hairline />
                  <View style={styles.row}>
                    <Text style={styles.rowLabel}>ID</Text>
                    <Text style={[styles.rowValue, styles.rowValueMono]} numberOfLines={1}>
                      {team.id}
                    </Text>
                  </View>
                </>
              ) : null}
              {onOpenWorkspaces ? (
                <>
                  <Hairline />
                  <Pressable
                    accessibilityRole="button"
                    onPress={onOpenWorkspaces}
                    style={({ pressed }) => [
                      styles.row,
                      pressed ? styles.rowPressed : null,
                    ]}
                  >
                    <Text style={styles.rowLabel}>Workspaces</Text>
                    <Ionicons color={colors.slate} name="chevron-forward" size={16} />
                  </Pressable>
                </>
              ) : null}
              {onOpenTeams ? (
                <>
                  <Hairline />
                  <Pressable
                    accessibilityRole="button"
                    onPress={onOpenTeams}
                    style={({ pressed }) => [
                      styles.row,
                      pressed ? styles.rowPressed : null,
                    ]}
                  >
                    <Text style={styles.rowLabel}>All teams</Text>
                    <Ionicons color={colors.slate} name="chevron-forward" size={16} />
                  </Pressable>
                </>
              ) : null}
            </View>
          </View>
        ) : null}

        <View style={styles.section}>
          <SectionEyebrow label="NOTIFICATIONS" style={styles.sectionEyebrow} />
          <View style={styles.card}>
            <View style={styles.row}>
              <View style={styles.rowBody}>
                <Text style={styles.rowLabel}>Push alerts</Text>
                <Text style={styles.rowHelper}>
                  Get a heads-up when an agent finishes a turn.
                </Text>
              </View>
              <Switch
                disabled={!onToggleNotifications}
                onValueChange={onToggleNotifications}
                thumbColor={notificationsEnabled ? colors.paper : colors.paper}
                trackColor={{ false: colors.pebble, true: colors.cinnabar }}
                value={notificationsEnabled}
              />
            </View>
            {onOpenNotifications ? (
              <>
                <Hairline />
                <Pressable
                  accessibilityRole="button"
                  onPress={onOpenNotifications}
                  style={({ pressed }) => [
                    styles.row,
                    pressed ? styles.rowPressed : null,
                  ]}
                >
                  <Text style={styles.rowLabel}>Per-event preferences</Text>
                  <Ionicons color={colors.slate} name="chevron-forward" size={16} />
                </Pressable>
              </>
            ) : null}
          </View>
        </View>

        <View style={styles.section}>
          <SectionEyebrow label="ABOUT" style={styles.sectionEyebrow} />
          <View style={styles.card}>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>App version</Text>
              <Text style={styles.rowValueMono}>{appVersion}</Text>
            </View>
            <Hairline />
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Build</Text>
              <Text style={styles.rowValueMono}>{buildNumber}</Text>
            </View>
          </View>
        </View>

        {onSignOut ? (
          <Pressable
            accessibilityRole="button"
            disabled={isSigningOut}
            onPress={onSignOut}
            style={({ pressed }) => [
              styles.signOutButton,
              isSigningOut ? styles.signOutButtonBusy : null,
              pressed && !isSigningOut ? styles.signOutButtonPressed : null,
            ]}
          >
            <Text style={styles.signOutText}>
              {isSigningOut ? "Signing out…" : "Sign out"}
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: {
    alignItems: "center",
    backgroundColor: hai.cinnabar,
    borderRadius: 28,
    height: 56,
    justifyContent: "center",
    width: 56,
  },
  avatarText: {
    color: hai.paper,
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  card: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  content: {
    gap: spacing.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
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
  identityBody: {
    flex: 1,
    gap: 2,
  },
  identityCard: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.md,
    padding: spacing.lg,
  },
  identityCardPressed: {
    opacity: 0.85,
  },
  upgradeBanner: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  upgradeBannerPressed: {
    opacity: 0.85,
  },
  upgradeBody: {
    flex: 1,
    gap: 2,
  },
  upgradeHelper: {
    color: colors.basalt,
    ...typography.caption,
  },
  upgradeTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
  identityEmail: {
    color: colors.slate,
    ...typography.monoMeta,
  },
  identityName: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
    justifyContent: "space-between",
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
  rowLabel: {
    color: colors.basalt,
    ...typography.body,
  },
  rowPressed: {
    backgroundColor: "rgba(34,32,29,0.04)",
  },
  rowValue: {
    color: colors.onyx,
    ...typography.body,
  },
  rowValueMono: {
    color: colors.onyx,
    ...typography.monoMeta,
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
  signOutButton: {
    alignItems: "center",
    backgroundColor: "rgba(184,75,54,0.10)",
    borderRadius: radii.button,
    paddingVertical: 14,
  },
  signOutButtonBusy: {
    opacity: 0.5,
  },
  signOutButtonPressed: {
    opacity: 0.7,
  },
  signOutText: {
    color: colors.cinnabar,
    ...typography.cardTitle,
  },
});

export default SettingsScreen;

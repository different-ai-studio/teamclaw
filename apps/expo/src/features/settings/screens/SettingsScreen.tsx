import { Ionicons } from "@expo/vector-icons";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";

import { Hairline } from "../../../ui/atoms/Hairline";
import { SectionEyebrow } from "../../../ui/atoms/SectionEyebrow";
import { colors, hai, radii, spacing, typography } from "../../../ui/theme";
import type { ConnectedAgent } from "../../actors/connected-agent-types";
import { isAgentOnline } from "../../actors/connected-agent-types";

export type SettingsTeam = {
  id?: string;
  name: string;
  role: string | null;
};

/** The `GET /v1/teams/:id` facts, resolved after the screen mounts. */
export type SettingsTeamDetails = {
  createdAt: string | null;
  orgName: string | null;
  ownerDisplayName: string | null;
};

export type SettingsScreenProps = {
  appVersion: string;
  buildNumber: string;
  displayName: string;
  avatarUrl?: string | null;
  /** Signed-in member's actor id, shown as the footer caption for support. */
  currentActorId?: string | null;
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
  teamDetails?: SettingsTeamDetails | null;
  teamDetailsError?: string | null;
  userEmail: string | null;
  /** Personal agents registered from the user's own devices. */
  connectedAgents?: ReadonlyArray<ConnectedAgent>;
  isLoadingConnectedAgents?: boolean;
  connectedAgentsError?: string | null;
  onShareAgentToTeam?: (agentId: string) => void;
  /** Team-wide default agent (`teams.default_agent_id`). */
  teamAgents?: ReadonlyArray<ConnectedAgent>;
  teamDefaultAgentId?: string | null;
  canEditTeamDefaultAgent?: boolean;
  isSavingTeamDefaultAgent?: boolean;
  teamDefaultAgentError?: string | null;
  onPickTeamDefaultAgent?: () => void;
  /** Endpoints the app is talking to, shown in About for support/diagnostics. */
  cloudApiAddress?: string;
  mqttBrokerAddress?: string;
};

function avatarInitials(name: string): string {
  const parts = name
    .split(/[\s·]+/)
    .filter(Boolean)
    .slice(0, 2);
  if (parts.length === 0) return name.slice(0, 1).toUpperCase();
  return parts.map((p) => p.charAt(0).toUpperCase()).join("");
}

function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** `Claude · prompt · personal` — the meta line under a connected agent. */
function agentMetaLine(agent: ConnectedAgent): string {
  const typeLabel = (() => {
    switch (agent.defaultAgentType) {
      case "claude":
      case "claude_code":
        return "Claude";
      case "opencode":
        return "OpenCode";
      case "codex":
        return "Codex";
      default:
        return "";
    }
  })();
  const parts = [typeLabel, agent.permissionLevel, agent.visibility].filter(Boolean);
  if (parts.length > 0) return parts.join(" · ");
  return isAgentOnline(agent) ? "online" : "offline";
}

export function SettingsScreen({
  appVersion,
  avatarUrl,
  buildNumber,
  canEditTeamDefaultAgent = false,
  cloudApiAddress,
  connectedAgents,
  connectedAgentsError,
  currentActorId,
  displayName,
  isAnonymous = false,
  isLoadingConnectedAgents = false,
  isSavingTeamDefaultAgent = false,
  isSigningOut = false,
  mqttBrokerAddress,
  notificationsEnabled = false,
  onClose,
  onEditProfile,
  onOpenNotifications,
  onOpenTeams,
  onOpenWorkspaces,
  onPickTeamDefaultAgent,
  onShareAgentToTeam,
  onSignOut,
  onToggleNotifications,
  onUpgrade,
  team,
  teamAgents,
  teamDefaultAgentError,
  teamDefaultAgentId,
  teamDetails,
  teamDetailsError,
  userEmail,
}: SettingsScreenProps) {
  const teamDefaultAgentName =
    (teamAgents ?? []).find((agent) => agent.agentId === teamDefaultAgentId)?.displayName ??
    null;
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
          {avatarUrl ? (
            <Image resizeMode="cover" source={{ uri: avatarUrl }} style={styles.avatar} />
          ) : (
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{avatarInitials(displayName)}</Text>
            </View>
          )}
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

        {connectedAgents ? (
          <View style={styles.section}>
            <SectionEyebrow
              label="CONNECTED PERSONAL AGENTS"
              style={styles.sectionEyebrow}
            />
            <View style={styles.card}>
              {isLoadingConnectedAgents && connectedAgents.length === 0 ? (
                <View style={styles.loadingRow}>
                  <ActivityIndicator color={colors.slate} />
                </View>
              ) : connectedAgents.length === 0 ? (
                <View style={styles.emptyBlock}>
                  <Text style={styles.emptyTitle}>No agents connected to you yet.</Text>
                  <Text style={styles.rowHelper}>
                    Personal agents registered from your devices will appear here.
                  </Text>
                </View>
              ) : (
                connectedAgents.map((agent, index) => {
                  const online = isAgentOnline(agent);
                  return (
                    <View key={agent.agentId}>
                      <View style={styles.agentRow}>
                        <View
                          style={[
                            styles.agentDot,
                            { backgroundColor: online ? hai.sage : hai.slate },
                          ]}
                        />
                        <View style={styles.rowBody}>
                          <Text numberOfLines={1} style={styles.agentName}>
                            {agent.displayName}
                          </Text>
                          <Text numberOfLines={1} style={styles.agentMeta}>
                            {agentMetaLine(agent)}
                          </Text>
                        </View>
                        {agent.isOwner && onShareAgentToTeam ? (
                          <Pressable
                            accessibilityRole="button"
                            hitSlop={6}
                            onPress={() => onShareAgentToTeam(agent.agentId)}
                          >
                            <Text style={styles.agentAction}>Share to team</Text>
                          </Pressable>
                        ) : null}
                        <Text
                          style={[
                            styles.agentStatus,
                            { color: online ? hai.sage : hai.slate },
                          ]}
                        >
                          {online ? "Online" : "Offline"}
                        </Text>
                      </View>
                      {index < connectedAgents.length - 1 ? <Hairline /> : null}
                    </View>
                  );
                })
              )}
              {connectedAgentsError ? (
                <>
                  <Hairline />
                  <Text style={styles.errorText}>{connectedAgentsError}</Text>
                </>
              ) : null}
            </View>
          </View>
        ) : null}

        {team ? (
          <View style={styles.section}>
            <SectionEyebrow label="TEAM" style={styles.sectionEyebrow} />
            <View style={styles.card}>
              {teamDetails?.orgName ? (
                <>
                  <View style={styles.row}>
                    <Text style={styles.rowLabel}>Org</Text>
                    <Text numberOfLines={1} style={styles.rowValue}>
                      {teamDetails.orgName}
                    </Text>
                  </View>
                  <Hairline />
                </>
              ) : null}
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Name</Text>
                <Text style={styles.rowValue}>{team.name}</Text>
              </View>
              <Hairline />
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Role</Text>
                <Text style={styles.rowValue}>{team.role ?? "member"}</Text>
              </View>
              {teamDetails ? (
                <>
                  <Hairline />
                  <View style={styles.row}>
                    <Text style={styles.rowLabel}>Owner</Text>
                    <Text numberOfLines={1} style={styles.rowValue}>
                      {teamDetails.ownerDisplayName ?? "—"}
                    </Text>
                  </View>
                  <Hairline />
                  <View style={styles.row}>
                    <Text style={styles.rowLabel}>Created</Text>
                    <Text style={styles.rowValue}>{formatTimestamp(teamDetails.createdAt)}</Text>
                  </View>
                </>
              ) : null}
              {teamDetailsError ? (
                <>
                  <Hairline />
                  <Text style={styles.errorText}>{teamDetailsError}</Text>
                </>
              ) : null}
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

        {team && teamAgents ? (
          <View style={styles.section}>
            <SectionEyebrow label="TEAM DEFAULT AGENT" style={styles.sectionEyebrow} />
            <View style={styles.card}>
              {teamAgents.length === 0 ? (
                <View style={styles.emptyBlock}>
                  <Text style={styles.rowHelper}>No team agents yet.</Text>
                </View>
              ) : canEditTeamDefaultAgent && onPickTeamDefaultAgent ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={isSavingTeamDefaultAgent}
                  onPress={onPickTeamDefaultAgent}
                  style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
                >
                  <Text style={styles.rowLabel}>Default agent</Text>
                  {isSavingTeamDefaultAgent ? (
                    <ActivityIndicator color={colors.slate} />
                  ) : (
                    <View style={styles.pickerValueRow}>
                      <Text numberOfLines={1} style={styles.rowValue}>
                        {teamDefaultAgentName ?? "Not set"}
                      </Text>
                      <Ionicons color={colors.slate} name="chevron-down" size={14} />
                    </View>
                  )}
                </Pressable>
              ) : (
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Default agent</Text>
                  <Text numberOfLines={1} style={styles.rowValue}>
                    {teamDefaultAgentName ?? "Not set"}
                  </Text>
                </View>
              )}
              {teamDefaultAgentError ? (
                <>
                  <Hairline />
                  <Text style={styles.errorText}>{teamDefaultAgentError}</Text>
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
            {/* The endpoints this build actually talks to. Support asks for
                these first when a device "can't connect". */}
            <Hairline />
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Cloud API</Text>
              <Text numberOfLines={1} style={styles.rowValueMono}>
                {cloudApiAddress || "—"}
              </Text>
            </View>
            <Hairline />
            <View style={styles.row}>
              <Text style={styles.rowLabel}>MQTT</Text>
              <Text numberOfLines={1} style={styles.rowValueMono}>
                {mqttBrokerAddress || "—"}
              </Text>
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

        {currentActorId ? (
          <Text selectable style={styles.actorIdCaption}>
            {currentActorId}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  actorIdCaption: {
    color: colors.slate,
    paddingHorizontal: spacing.xl,
    textAlign: "center",
    ...typography.monoMeta,
  },
  agentAction: {
    color: colors.basalt,
    ...typography.cardTitle,
  },
  agentDot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  agentMeta: {
    color: colors.basalt,
    ...typography.monoMeta,
  },
  agentName: {
    color: colors.onyx,
    ...typography.body,
    fontWeight: "600",
  },
  agentRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  agentStatus: {
    ...typography.caption,
  },
  emptyBlock: {
    gap: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  emptyTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
  errorText: {
    color: hai.cinnabarDeep,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    ...typography.caption,
  },
  loadingRow: {
    paddingVertical: spacing.lg,
  },
  pickerValueRow: {
    alignItems: "center",
    flexDirection: "row",
    flexShrink: 1,
    gap: spacing.xs,
  },
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

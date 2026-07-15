import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { Hairline } from "../../../ui/atoms/Hairline";
import { SectionEyebrow } from "../../../ui/atoms/SectionEyebrow";
import { StatusDot } from "../../../ui/atoms/StatusDot";
import { formatRelativeTime } from "../../../lib/relative-time";
import { colors, hai, radii, spacing, typography } from "../../../ui/theme";
import { isActorOnline, type Actor } from "../actor-types";
import type { AgentAuthorizedHuman } from "../connected-agent-types";

export type AgentWorkspaceChoice = {
  id: string;
  name: string;
  path: string | null;
  agentId?: string | null;
};

export type ActorDetailScreenProps = {
  actor: Actor | null;
  isLoading: boolean;
  isMe: boolean;
  isRefreshing?: boolean;
  isRemoving?: boolean;
  isCreatingReinvite?: boolean;
  isGrantingAuthorizedHuman?: boolean;
  isLoadingAuthorizedHumans?: boolean;
  isAddingAgentWorkspace?: boolean;
  isRemovingAgentWorkspace?: boolean;
  isRevokingAuthorizedHuman?: boolean;
  isSavingAgentDefaults?: boolean;
  isUpdatingAgentVisibility?: boolean;
  onClose: () => void;
  onCreateReinvite?: () => void;
  onGrantAuthorizedHuman?: (memberActorId: string) => void;
  onAddAgentWorkspace?: (path: string) => void;
  onMakeAgentPersonal?: () => void;
  onRefresh?: () => void;
  onRemoveActor?: () => void;
  onRemoveAgentWorkspace?: (workspaceId: string) => void;
  onRevokeAuthorizedHuman?: (memberActorId: string) => void;
  onSelectSession?: (sessionId: string) => void;
  onShareAgentToTeam?: () => void;
  onUpdateAgentDefaults?: (patch: {
    defaultWorkspaceId?: string | null;
    defaultAgentType?: string | null;
  }) => void;
  agentWorkspaces?: ReadonlyArray<AgentWorkspaceChoice>;
  authorizedHumans?: ReadonlyArray<AgentAuthorizedHuman>;
  authorizedMemberCandidates?: ReadonlyArray<Actor>;
  recentSessions?: ReadonlyArray<{
    sessionId: string;
    title: string;
    lastMessageAt: string;
  }>;
  stats?: {
    sessions: number;
    ideas: number;
  };
};

const HUMAN_PALETTE = [hai.basalt, hai.slate, hai.sage, hai.onyx];

function avatarInitials(name: string): string {
  const parts = name
    .split(/[\s·]+/)
    .filter(Boolean)
    .slice(0, 2);
  if (parts.length === 0) return name.slice(0, 1).toUpperCase();
  return parts.map((p) => p.charAt(0).toUpperCase()).join("");
}

function hashActorId(actorId: string): number {
  let hash = 0;
  for (let i = 0; i < actorId.length; i += 1) hash = (hash + actorId.charCodeAt(i)) >>> 0;
  return hash;
}

function deriveHeroStyle(actor: Actor, isMe: boolean) {
  if (actor.actorType === "agent") {
    return { background: hai.pebble, foreground: hai.basalt, isSquare: true };
  }
  if (isMe) {
    return { background: hai.cinnabar, foreground: hai.paper, isSquare: false };
  }
  return {
    background: HUMAN_PALETTE[hashActorId(actor.actorId) % HUMAN_PALETTE.length],
    foreground: hai.paper,
    isSquare: false,
  };
}

function deriveKindLabel(actor: Actor): string {
  if (actor.actorType === "member") return "Human";
  if (actor.actorType === "agent") return "Agent";
  return "External";
}

function deriveSubtitle(actor: Actor, isMe: boolean): string {
  if (isMe) return "you";
  if (actor.actorType === "agent") return "Agent";
  return actor.role ?? "member";
}

export function ActorDetailScreen({
  actor,
  isLoading,
  isMe,
  agentWorkspaces,
  authorizedHumans,
  authorizedMemberCandidates,
  isCreatingReinvite,
  isGrantingAuthorizedHuman,
  isLoadingAuthorizedHumans,
  isAddingAgentWorkspace,
  isRefreshing,
  isRemoving,
  isRemovingAgentWorkspace,
  isRevokingAuthorizedHuman,
  isSavingAgentDefaults,
  isUpdatingAgentVisibility,
  onClose,
  onCreateReinvite,
  onGrantAuthorizedHuman,
  onAddAgentWorkspace,
  onMakeAgentPersonal,
  onRefresh,
  onRemoveActor,
  onRemoveAgentWorkspace,
  onRevokeAuthorizedHuman,
  onSelectSession,
  onShareAgentToTeam,
  onUpdateAgentDefaults,
  recentSessions,
  stats,
}: ActorDetailScreenProps) {
  return (
    <View style={styles.screen}>
      <View style={styles.headerBar}>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>Actor</Text>
        <Pressable hitSlop={8} onPress={onClose} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </View>
      <Hairline />

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          onRefresh ? (
            <RefreshControl
              onRefresh={onRefresh}
              refreshing={Boolean(isRefreshing)}
              tintColor={colors.slate}
            />
          ) : undefined
        }
      >
        {isLoading && actor === null ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.slate} />
            <Text style={styles.loadingText}>Loading actor…</Text>
          </View>
        ) : actor === null ? (
          <View style={styles.stateBlock}>
            <Text style={styles.stateTitle}>Actor not found</Text>
            <Text style={styles.stateBody}>
              The actor may have been removed from this team.
            </Text>
          </View>
        ) : (
          <>
            <HeroCard actor={actor} isMe={isMe} />

            {stats ? (
              <View style={styles.statsRow}>
                <View style={styles.statTile}>
                  <Text style={styles.statValue}>{stats.sessions}</Text>
                  <Text style={styles.statLabel}>Sessions</Text>
                </View>
                <View style={styles.statTile}>
                  <Text style={styles.statValue}>{stats.ideas}</Text>
                  <Text style={styles.statLabel}>Ideas</Text>
                </View>
              </View>
            ) : null}

            {recentSessions ? (
              <View style={styles.section}>
                <SectionEyebrow
                  label={
                    recentSessions.length > 0
                      ? `RECENT SESSIONS · ${recentSessions.length}`
                      : "RECENT SESSIONS"
                  }
                  style={styles.sectionEyebrow}
                />
                <View style={styles.card}>
                  {recentSessions.length === 0 ? (
                    <Text style={styles.emptyRecent}>No recent sessions yet.</Text>
                  ) : null}
                  {recentSessions.map((row, index) => {
                    const ts = row.lastMessageAt
                      ? Date.parse(row.lastMessageAt)
                      : 0;
                    const isFresh = ts > 0 && Date.now() - ts < 5 * 60 * 1000;
                    return (
                      <View key={row.sessionId}>
                        <Pressable
                          accessibilityRole="button"
                          onPress={
                            onSelectSession
                              ? () => onSelectSession(row.sessionId)
                              : undefined
                          }
                          style={({ pressed }) => [
                            styles.recentSessionRow,
                            pressed && onSelectSession ? { opacity: 0.7 } : null,
                          ]}
                        >
                          <StatusDot kind={isFresh ? "active" : "muted"} size={8} />
                          <Text numberOfLines={1} style={styles.recentSessionTitle}>
                            {row.title || "Untitled session"}
                          </Text>
                          <Text style={styles.recentSessionTime}>
                            {row.lastMessageAt ? formatRelativeTime(row.lastMessageAt) : "—"}
                          </Text>
                        </Pressable>
                        {index < recentSessions.length - 1 ? <Hairline /> : null}
                      </View>
                    );
                  })}
                </View>
              </View>
            ) : null}

            <View style={styles.section}>
              <SectionEyebrow label="INFO" style={styles.sectionEyebrow} />
              <View style={styles.card}>
                <DetailRow label="Name" value={actor.displayName} />
                <Hairline />
                <DetailRow label="Kind" value={deriveKindLabel(actor)} />
                <Hairline />
                <DetailRow
                  label={actor.actorType === "member" ? "Role" : "Status"}
                  value={deriveSubtitle(actor, isMe)}
                />
                {actor.actorType === "agent" ? (
                  <>
                    <Hairline />
                    <DetailRow
                      label="Visibility"
                      value={actor.visibility === "personal" ? "Personal" : "Team"}
                    />
                  </>
                ) : null}
                <Hairline />
                <DetailRow
                  label="Online"
                  value={isActorOnline(actor) ? "Yes" : "No"}
                />
              </View>
            </View>

            {actor.actorType === "agent" ? (
              <>
                <AgentDefaultsSection
                  actor={actor}
                  isSaving={Boolean(isSavingAgentDefaults)}
                  onUpdate={onUpdateAgentDefaults}
                  workspaces={agentWorkspaces ?? []}
                />
                <AgentWorkspacesSection
                  actor={actor}
                  isAdding={Boolean(isAddingAgentWorkspace)}
                  isRemoving={Boolean(isRemovingAgentWorkspace)}
                  onAdd={onAddAgentWorkspace}
                  onRemove={onRemoveAgentWorkspace}
                  workspaces={(agentWorkspaces ?? []).filter(
                    (workspace) => workspace.agentId === actor.actorId,
                  )}
                />
                <AuthorizedMembersSection
                  candidates={authorizedMemberCandidates ?? []}
                  humans={authorizedHumans ?? []}
                  isGranting={Boolean(isGrantingAuthorizedHuman)}
                  isLoading={Boolean(isLoadingAuthorizedHumans)}
                  isRevoking={Boolean(isRevokingAuthorizedHuman)}
                  onGrant={onGrantAuthorizedHuman}
                  onRevoke={onRevokeAuthorizedHuman}
                />
                {onShareAgentToTeam || onMakeAgentPersonal ? (
                  <AgentVisibilitySection
                    actor={actor}
                    isUpdating={Boolean(isUpdatingAgentVisibility)}
                    onMakePersonal={onMakeAgentPersonal}
                    onShareToTeam={onShareAgentToTeam}
                  />
                ) : null}
              </>
            ) : null}

            {onCreateReinvite ? (
              <View style={styles.section}>
                <SectionEyebrow label="RE-INVITE" style={styles.sectionEyebrow} />
                <View style={styles.card}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={Boolean(isCreatingReinvite)}
                    onPress={onCreateReinvite}
                    style={({ pressed }) => [
                      styles.managementRow,
                      pressed && !isCreatingReinvite ? styles.managementRowPressed : null,
                      isCreatingReinvite ? styles.managementRowDisabled : null,
                    ]}
                  >
                    <Ionicons color={hai.basalt} name="link-outline" size={18} />
                    <View style={styles.managementBody}>
                      <Text style={styles.neutralActionTitle}>
                        {actor.actorType === "agent"
                          ? "Regenerate invite link"
                          : "Generate re-invite link"}
                      </Text>
                      <Text style={styles.managementHelper}>
                        {actor.actorType === "agent"
                          ? "Use this if the daemon needs to pair again."
                          : "Useful for anonymous members who lost access."}
                      </Text>
                    </View>
                    {isCreatingReinvite ? <ActivityIndicator color={colors.slate} /> : null}
                  </Pressable>
                </View>
              </View>
            ) : null}

            {onRemoveActor ? (
              <View style={styles.section}>
                <SectionEyebrow label="MANAGEMENT" style={styles.sectionEyebrow} />
                <View style={styles.card}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={Boolean(isRemoving)}
                    onPress={onRemoveActor}
                    style={({ pressed }) => [
                      styles.managementRow,
                      pressed && !isRemoving ? styles.managementRowPressed : null,
                      isRemoving ? styles.managementRowDisabled : null,
                    ]}
                  >
                    <Ionicons color={hai.cinnabar} name="trash-outline" size={18} />
                    <View style={styles.managementBody}>
                      <Text style={styles.managementTitle}>Remove from team</Text>
                      <Text style={styles.managementHelper}>
                        Revokes this actor's access and removes it from team lists.
                      </Text>
                    </View>
                    {isRemoving ? <ActivityIndicator color={colors.slate} /> : null}
                  </Pressable>
                </View>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function HeroCard({ actor, isMe }: { actor: Actor; isMe: boolean }) {
  const style = deriveHeroStyle(actor, isMe);
  const initials = avatarInitials(actor.displayName);
  const online = isActorOnline(actor);
  return (
    <View style={styles.hero}>
      <View
        style={[
          styles.heroAvatar,
          {
            backgroundColor: style.background,
            borderRadius: style.isSquare ? 16 : 999,
          },
        ]}
      >
        <Text style={[styles.heroAvatarText, { color: style.foreground }]}>{initials}</Text>
      </View>
      <View style={styles.heroBody}>
        <Text numberOfLines={1} style={styles.heroName}>
          {actor.displayName}
        </Text>
        <View style={styles.heroStatusRow}>
          <View
            style={[
              styles.heroDot,
              { backgroundColor: online ? hai.sage : hai.slate },
            ]}
          />
          <Text style={styles.heroStatus}>{online ? "Online" : "Offline"}</Text>
          <Text style={styles.heroSeparator}>·</Text>
          <Text style={styles.heroKind}>{deriveKindLabel(actor)}</Text>
        </View>
      </View>
    </View>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

function normalizeAgentType(value: string): string {
  if (value === "claude_code" || value === "claude-code") return "claude";
  return value;
}

function agentTypeLabel(value: string): string {
  switch (normalizeAgentType(value)) {
    case "opencode":
      return "OpenCode";
    case "codex":
      return "Codex";
    case "pi":
      return "Pi";
    case "claude":
      return "Claude";
    default:
      return value;
  }
}

function supportedAgentTypes(actor: Actor): string[] {
  const normalized = actor.agentTypes.map(normalizeAgentType);
  const unique = Array.from(new Set(normalized));
  if (unique.length > 0) return unique;
  return actor.defaultAgentType ? [normalizeAgentType(actor.defaultAgentType)] : [];
}

function workspaceLabel(workspace: AgentWorkspaceChoice): string {
  return workspace.name?.trim() || workspace.path?.trim() || workspace.id;
}

function AgentDefaultsSection({
  actor,
  isSaving,
  onUpdate,
  workspaces,
}: {
  actor: Actor;
  isSaving: boolean;
  onUpdate?: (patch: {
    defaultWorkspaceId?: string | null;
    defaultAgentType?: string | null;
  }) => void;
  workspaces: ReadonlyArray<AgentWorkspaceChoice>;
}) {
  const typeChoices = supportedAgentTypes(actor);
  const selectedType = normalizeAgentType(
    actor.defaultAgentType ?? actor.agentTypes[0] ?? "",
  );
  return (
    <View style={styles.section}>
      <SectionEyebrow label="DEFAULTS" style={styles.sectionEyebrow} />
      <View style={styles.card}>
        <View style={styles.optionBlock}>
          <Text style={styles.optionLabel}>Default workspace</Text>
          {workspaces.length === 0 ? (
            <Text style={styles.optionEmpty}>No active workspaces yet.</Text>
          ) : (
            <View style={styles.chipWrap}>
              {workspaces.map((workspace) => {
                const selected = actor.defaultWorkspaceId === workspace.id;
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: isSaving, selected }}
                    disabled={isSaving || !onUpdate || selected}
                    key={workspace.id}
                    onPress={() => onUpdate?.({ defaultWorkspaceId: workspace.id })}
                    style={[
                      styles.optionChip,
                      selected ? styles.optionChipSelected : null,
                      isSaving ? styles.optionChipDisabled : null,
                    ]}
                  >
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.optionChipText,
                        selected ? styles.optionChipTextSelected : null,
                      ]}
                    >
                      {workspaceLabel(workspace)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>
        <Hairline />
        <View style={styles.optionBlock}>
          <Text style={styles.optionLabel}>Agent type</Text>
          {typeChoices.length === 0 ? (
            <Text style={styles.optionEmpty}>No supported agent type reported.</Text>
          ) : (
            <View style={styles.chipWrap}>
              {typeChoices.map((agentType) => {
                const selected = selectedType === agentType;
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: isSaving, selected }}
                    disabled={isSaving || !onUpdate || selected}
                    key={agentType}
                    onPress={() => onUpdate?.({ defaultAgentType: agentType })}
                    style={[
                      styles.optionChip,
                      selected ? styles.optionChipSelected : null,
                      isSaving ? styles.optionChipDisabled : null,
                    ]}
                  >
                    <Text
                      style={[
                        styles.optionChipText,
                        selected ? styles.optionChipTextSelected : null,
                      ]}
                    >
                      {agentTypeLabel(agentType)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}
          {isSaving ? <Text style={styles.optionEmpty}>Saving…</Text> : null}
        </View>
      </View>
    </View>
  );
}

function AgentWorkspacesSection({
  actor,
  isAdding,
  isRemoving,
  onAdd,
  onRemove,
  workspaces,
}: {
  actor: Actor;
  isAdding: boolean;
  isRemoving: boolean;
  onAdd?: (path: string) => void;
  onRemove?: (workspaceId: string) => void;
  workspaces: ReadonlyArray<AgentWorkspaceChoice>;
}) {
  const [path, setPath] = useState("");
  // An agent's daemon is addressed by its actor id; routing is available
  // whenever this is an agent actor.
  const canRoute = actor.actorType === "agent";
  const canAdd = Boolean(onAdd) && canRoute && path.trim().length > 0 && !isAdding;
  return (
    <View style={styles.section}>
      <SectionEyebrow
        label={`WORKSPACES · ${workspaces.length}`}
        style={styles.sectionEyebrow}
      />
      <View style={styles.card}>
        {workspaces.length === 0 ? (
          <Text style={styles.optionEmptyPadded}>No daemon workspaces linked yet.</Text>
        ) : (
          workspaces.map((workspace, index) => (
            <View key={workspace.id}>
              <View style={styles.workspaceRow}>
                <View style={styles.authorizedBody}>
                  <Text style={styles.authorizedName}>{workspaceLabel(workspace)}</Text>
                  <Text numberOfLines={1} style={styles.authorizedMeta}>
                    {workspace.path ?? workspace.id}
                  </Text>
                </View>
                {onRemove ? (
                  <Pressable
                    accessibilityLabel={`Remove ${workspaceLabel(workspace)}`}
                    accessibilityRole="button"
                    disabled={isRemoving || !canRoute}
                    hitSlop={6}
                    onPress={() => onRemove(workspace.id)}
                    style={isRemoving || !canRoute ? styles.optionChipDisabled : null}
                  >
                    <Ionicons color={hai.cinnabar} name="trash-outline" size={19} />
                  </Pressable>
                ) : null}
              </View>
              {index < workspaces.length - 1 ? <Hairline /> : null}
            </View>
          ))
        )}
        {onAdd ? (
          <>
            <Hairline />
            <View style={styles.workspaceAddRow}>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                editable={!isAdding && canRoute}
                onChangeText={setPath}
                placeholder="/Users/me/project"
                placeholderTextColor={colors.slate}
                selectionColor={colors.cinnabar}
                style={styles.workspaceInput}
                value={path}
              />
              <Pressable
                accessibilityRole="button"
                disabled={!canAdd}
                onPress={() => {
                  const next = path.trim();
                  if (!next) return;
                  onAdd(next);
                  setPath("");
                }}
                style={[
                  styles.optionChip,
                  canAdd ? styles.workspaceAddButton : styles.optionChipDisabled,
                ]}
              >
                <Text
                  style={[
                    styles.optionChipText,
                    canAdd ? styles.workspaceAddButtonText : null,
                  ]}
                >
                  {isAdding ? "Adding…" : "Add"}
                </Text>
              </Pressable>
            </View>
            {!canRoute ? (
              <Text style={styles.workspaceHint}>
                Daemon routing is unavailable for this actor.
              </Text>
            ) : null}
          </>
        ) : null}
      </View>
    </View>
  );
}

function AuthorizedMembersSection({
  candidates,
  humans,
  isGranting,
  isLoading,
  isRevoking,
  onGrant,
  onRevoke,
}: {
  candidates: ReadonlyArray<Actor>;
  humans: ReadonlyArray<AgentAuthorizedHuman>;
  isGranting: boolean;
  isLoading: boolean;
  isRevoking: boolean;
  onGrant?: (memberActorId: string) => void;
  onRevoke?: (memberActorId: string) => void;
}) {
  return (
    <View style={styles.section}>
      <SectionEyebrow
        label={`AUTHORIZED MEMBERS · ${humans.length}`}
        style={styles.sectionEyebrow}
      />
      <View style={styles.card}>
        {isLoading ? (
          <View style={styles.loadingRowInline}>
            <ActivityIndicator color={colors.slate} />
            <Text style={styles.optionEmpty}>Loading authorized members…</Text>
          </View>
        ) : humans.length === 0 ? (
          <Text style={styles.optionEmptyPadded}>No members authorized yet.</Text>
        ) : (
          humans.map((human, index) => (
            <View key={human.id}>
              <View style={styles.authorizedRow}>
                <View style={styles.authorizedBody}>
                  <Text style={styles.authorizedName}>{human.displayName}</Text>
                  <Text style={styles.authorizedMeta}>{human.permissionLevel}</Text>
                </View>
                {onRevoke ? (
                  <Pressable
                    accessibilityLabel={`Revoke ${human.displayName}`}
                    accessibilityRole="button"
                    disabled={isRevoking}
                    hitSlop={6}
                    onPress={() => onRevoke(human.id)}
                    style={isRevoking ? styles.optionChipDisabled : null}
                  >
                    <Ionicons color={hai.cinnabar} name="remove-circle-outline" size={20} />
                  </Pressable>
                ) : null}
              </View>
              {index < humans.length - 1 ? <Hairline /> : null}
            </View>
          ))
        )}
      </View>
      {onGrant ? (
        <View style={styles.card}>
          <View style={styles.optionBlock}>
            <Text style={styles.optionLabel}>Add prompt access</Text>
            {candidates.length === 0 ? (
              <Text style={styles.optionEmpty}>All team members are already authorized.</Text>
            ) : (
              <View style={styles.chipWrap}>
                {candidates.map((candidate) => (
                  <Pressable
                    accessibilityRole="button"
                    disabled={isGranting}
                    key={candidate.actorId}
                    onPress={() => onGrant(candidate.actorId)}
                    style={[
                      styles.optionChip,
                      isGranting ? styles.optionChipDisabled : null,
                    ]}
                  >
                    <Text style={styles.optionChipText}>{candidate.displayName}</Text>
                  </Pressable>
                ))}
              </View>
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function AgentVisibilitySection({
  actor,
  isUpdating,
  onMakePersonal,
  onShareToTeam,
}: {
  actor: Actor;
  isUpdating: boolean;
  onMakePersonal?: () => void;
  onShareToTeam?: () => void;
}) {
  const isPersonal = actor.visibility === "personal";
  const action = isPersonal ? onShareToTeam : onMakePersonal;
  return (
    <View style={styles.section}>
      <SectionEyebrow label="VISIBILITY" style={styles.sectionEyebrow} />
      <View style={styles.card}>
        <Pressable
          accessibilityRole="button"
          disabled={isUpdating || !action}
          onPress={action}
          style={({ pressed }) => [
            styles.managementRow,
            pressed && !isUpdating ? styles.managementRowPressed : null,
            isUpdating || !action ? styles.managementRowDisabled : null,
          ]}
        >
          <Ionicons
            color={hai.basalt}
            name={isPersonal ? "people-outline" : "person-outline"}
            size={18}
          />
          <View style={styles.managementBody}>
            <Text style={styles.neutralActionTitle}>
              {isPersonal ? "Share to team" : "Make personal"}
            </Text>
            <Text style={styles.managementHelper}>
              {isPersonal
                ? "Team members can discover this agent after sharing."
                : "Only the owner keeps access after making it personal."}
            </Text>
          </View>
          {isUpdating ? <ActivityIndicator color={colors.slate} /> : null}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
  authorizedBody: {
    flex: 1,
    gap: 2,
  },
  authorizedMeta: {
    color: colors.slate,
    textTransform: "capitalize",
    ...typography.caption,
  },
  authorizedName: {
    color: colors.onyx,
    ...typography.body,
  },
  authorizedRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  chipWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
  },
  detailLabel: {
    color: colors.basalt,
    ...typography.body,
  },
  detailRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  detailValue: {
    color: colors.onyx,
    ...typography.body,
  },
  recentSessionRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  recentSessionTime: {
    color: colors.slate,
    ...typography.caption,
  },
  recentSessionTitle: {
    color: colors.onyx,
    flex: 1,
    ...typography.body,
  },
  emptyRecent: {
    color: colors.slate,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    ...typography.secondaryBody,
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
  hero: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.md,
    padding: spacing.lg,
  },
  heroAvatar: {
    alignItems: "center",
    height: 72,
    justifyContent: "center",
    width: 72,
  },
  heroAvatarText: {
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  heroBody: {
    flex: 1,
    gap: 6,
  },
  heroDot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  heroKind: {
    color: colors.slate,
    ...typography.caption,
  },
  heroName: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
  heroSeparator: {
    color: colors.slate,
    ...typography.caption,
  },
  heroStatus: {
    color: colors.basalt,
    ...typography.caption,
  },
  heroStatusRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  loadingText: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  loadingRowInline: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  managementBody: {
    flex: 1,
    gap: 2,
  },
  managementHelper: {
    color: colors.slate,
    ...typography.caption,
  },
  managementRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  managementRowDisabled: {
    opacity: 0.5,
  },
  managementRowPressed: {
    opacity: 0.75,
  },
  managementTitle: {
    color: hai.cinnabar,
    ...typography.body,
    fontWeight: "700",
  },
  neutralActionTitle: {
    color: colors.onyx,
    ...typography.body,
    fontWeight: "700",
  },
  optionBlock: {
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  optionChip: {
    backgroundColor: hai.pebble,
    borderColor: colors.hairline,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: "100%",
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  optionChipDisabled: {
    opacity: 0.5,
  },
  optionChipSelected: {
    backgroundColor: hai.basalt,
    borderColor: hai.basalt,
  },
  optionChipText: {
    color: hai.basalt,
    ...typography.caption,
    fontWeight: "600",
  },
  optionChipTextSelected: {
    color: hai.paper,
  },
  optionEmpty: {
    color: colors.slate,
    ...typography.caption,
  },
  optionEmptyPadded: {
    color: colors.slate,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    ...typography.caption,
  },
  optionLabel: {
    color: colors.onyx,
    ...typography.body,
    fontWeight: "700",
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
  stateBlock: {
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  stateBody: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  stateTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
  statLabel: {
    color: colors.slate,
    ...typography.monoMeta,
  },
  statTile: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    gap: 4,
    paddingVertical: spacing.md,
  },
  statValue: {
    color: colors.onyx,
    fontSize: 22,
    fontWeight: "700",
  },
  statsRow: {
    flexDirection: "row",
    gap: spacing.md,
  },
  workspaceAddButton: {
    backgroundColor: hai.basalt,
    borderColor: hai.basalt,
  },
  workspaceAddButtonText: {
    color: hai.paper,
  },
  workspaceAddRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  workspaceHint: {
    color: colors.slate,
    paddingBottom: spacing.md,
    paddingHorizontal: spacing.md,
    ...typography.caption,
  },
  workspaceInput: {
    color: colors.onyx,
    flex: 1,
    padding: 0,
    ...typography.monoMeta,
  },
  workspaceRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
});

export default ActorDetailScreen;

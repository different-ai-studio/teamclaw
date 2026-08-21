import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Hairline } from "../../../ui/atoms/Hairline";
import { t } from "../../../lib/i18n";
import { GlassHeader, GLASS_HEADER_HEIGHT } from "../../../ui/GlassHeader";
import { colors, hai, radii, spacing, typography } from "../../../ui/theme";
import {
  isActorScopedResource,
  type TeamEnvSecret,
  type TeamMcpServer,
  type TeamResourceKind,
  type TeamSkill,
} from "../team-resources-api";

/**
 * Second-level destination from an actor's detail screen: the skills or MCP
 * servers that actor has installed, or the team's environment keys. Ported from
 * the iOS `ActorResourceListView`.
 */

export type ActorResourceListScreenProps = {
  actorName: string;
  envKeys?: ReadonlyArray<TeamEnvSecret>;
  errorMessage?: string | null;
  isLoading: boolean;
  kind: TeamResourceKind;
  onClose: () => void;
  servers?: ReadonlyArray<TeamMcpServer>;
  skills?: ReadonlyArray<TeamSkill>;
};

export function resourceKindTitle(kind: TeamResourceKind): string {
  switch (kind) {
    case "skills":
      return t("Skills");
    case "mcp":
      return t("MCP");
    case "env":
      return t("Env");
  }
}

function emptyTitle(kind: TeamResourceKind): string {
  switch (kind) {
    case "skills":
      return t("No skills installed");
    case "mcp":
      return t("No MCP servers installed");
    case "env":
      return t("No environment keys");
  }
}

function emptyDescription(kind: TeamResourceKind, actorName: string): string {
  if (kind === "env") return t("This team has not set any shared environment variables.");
  return t("{{value}} has nothing installed from the team catalog yet.", { value: actorName });
}

function formatUpdated(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString();
}

export function ActorResourceListScreen({
  actorName,
  envKeys,
  errorMessage,
  isLoading,
  kind,
  onClose,
  servers,
  skills,
}: ActorResourceListScreenProps) {
  const { t: tHook } = useTranslation();
  const rows =
    kind === "skills" ? skills ?? [] : kind === "mcp" ? servers ?? [] : envKeys ?? [];
  const isEmpty = rows.length === 0;

  return (
    <View style={styles.screen}>
      <GlassHeader>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>{resourceKindTitle(kind)}</Text>
        <Pressable hitSlop={8} onPress={onClose} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </GlassHeader>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.scopeNote}>
          {isActorScopedResource(kind)
            ? tHook("Installed for {{value}}.", { value: actorName })
            : tHook("Shared by the whole team. Values are encrypted and never leave the server in the clear.")}
        </Text>

        {errorMessage ? (
          <View style={styles.card}>
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        ) : isLoading ? (
          <View style={styles.stateRow}>
            <ActivityIndicator color={colors.slate} />
          </View>
        ) : isEmpty ? (
          <View style={styles.stateBlock}>
            <Text style={styles.stateTitle}>{emptyTitle(kind)}</Text>
            <Text style={styles.stateBody}>{emptyDescription(kind, actorName)}</Text>
          </View>
        ) : (
          <View style={styles.card}>
            {kind === "skills"
              ? (skills ?? []).map((skill, index) => (
                  <View key={skill.id}>
                    <View style={styles.row}>
                      <View style={styles.rowHeader}>
                        <Text style={styles.rowTitle}>{skill.slug}</Text>
                        {skill.hasUpdate ? (
                          <Text style={styles.updateTag}>{tHook("UPDATE")}</Text>
                        ) : null}
                        <View style={styles.rowSpacer} />
                        {skill.installedVersion !== null ? (
                          <Text style={styles.rowMeta}>v{skill.installedVersion}</Text>
                        ) : null}
                      </View>
                      {skill.summary ? (
                        <Text numberOfLines={2} style={styles.rowSubtitle}>
                          {skill.summary}
                        </Text>
                      ) : null}
                    </View>
                    {index < (skills ?? []).length - 1 ? <Hairline /> : null}
                  </View>
                ))
              : null}

            {kind === "mcp"
              ? (servers ?? []).map((server, index) => {
                  // `local` runs a command, `remote` hits a URL — exactly one
                  // is populated, so show whichever it is.
                  const detail = server.command ?? server.url ?? "";
                  return (
                    <View key={server.id}>
                      <View style={styles.row}>
                        <View style={styles.rowHeader}>
                          <Text style={styles.rowTitle}>{server.name}</Text>
                          <View style={styles.rowSpacer} />
                          <Text style={styles.rowMeta}>{server.transport.toUpperCase()}</Text>
                        </View>
                        {detail ? (
                          <Text numberOfLines={1} style={styles.rowMono}>
                            {detail}
                          </Text>
                        ) : null}
                      </View>
                      {index < (servers ?? []).length - 1 ? <Hairline /> : null}
                    </View>
                  );
                })
              : null}

            {kind === "env"
              ? (envKeys ?? []).map((secret, index) => (
                  <View key={secret.keyId}>
                    <View style={[styles.row, styles.envRow]}>
                      <Text style={styles.rowMono}>{secret.keyId}</Text>
                      <View style={styles.rowSpacer} />
                      <Text style={styles.rowMeta}>{formatUpdated(secret.updatedAt)}</Text>
                    </View>
                    {index < (envKeys ?? []).length - 1 ? <Hairline /> : null}
                  </View>
                ))
              : null}
          </View>
        )}
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
    overflow: "hidden",
  },
  content: {
    gap: spacing.md,
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
    paddingTop: GLASS_HEADER_HEIGHT + spacing.lg,
  },
  envRow: {
    alignItems: "center",
    flexDirection: "row",
  },
  errorText: {
    color: hai.cinnabarDeep,
    padding: spacing.md,
    ...typography.secondaryBody,
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
  row: {
    gap: 3,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  rowHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
  },
  rowMeta: {
    color: colors.slate,
    ...typography.monoMeta,
  },
  rowMono: {
    color: colors.basalt,
    ...typography.monoMeta,
  },
  rowSpacer: {
    flex: 1,
  },
  rowSubtitle: {
    color: colors.slate,
    ...typography.caption,
  },
  rowTitle: {
    color: colors.onyx,
    ...typography.body,
    fontWeight: "600",
  },
  scopeNote: {
    color: colors.slate,
    paddingHorizontal: spacing.xs,
    ...typography.caption,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  stateBlock: {
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  stateBody: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  stateRow: {
    paddingVertical: spacing.lg,
  },
  stateTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
  updateTag: {
    color: hai.cinnabar,
    fontSize: 10,
    fontWeight: "700",
  },
});

export default ActorResourceListScreen;

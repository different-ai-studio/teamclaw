import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { useOnboarding } from "../_layout";
import { Hairline } from "../../src/ui/atoms/Hairline";
import { SectionEyebrow } from "../../src/ui/atoms/SectionEyebrow";
import { createActorsApi } from "../../src/features/actors/actor-api";
import { CloudApiError, supabaseAccessToken } from "../../src/lib/cloud-api/client";
import { supabase } from "../../src/lib/supabase/client";
import { showToast } from "../../src/ui/Toast";
import { colors, hai, radii, spacing, typography } from "../../src/ui/theme";
import { GlassHeader, GLASS_HEADER_HEIGHT } from "../../src/ui/GlassHeader";

type Kind = "member" | "agent";
type Role = "member" | "admin";

type InviteResult = {
  token: string;
  deeplink: string;
  expiresAt: string;
};

function buildDeeplink(token: string): string {
  return `teamclu://invite/${token}`;
}

export default function InviteRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const teamId = state.currentTeam?.id ?? "";

  const [kind, setKind] = useState<Kind>("member");
  const [role, setRole] = useState<Role>("member");
  const [agentKind, setAgentKind] = useState("daemon");
  const [name, setName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A member invite into the shared default org comes back 403
  // `upgrade_required`. iOS swaps the invite form for an upgrade form rather
  // than reporting a dead end, and the team leaves the public org in place.
  const [needsUpgrade, setNeedsUpgrade] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [contact, setContact] = useState("");
  const [isUpgrading, setIsUpgrading] = useState(false);
  const [invite, setInvite] = useState<InviteResult | null>(null);

  const canInvite = name.trim().length > 0 && !isCreating && invite === null;

  const handleCreate = async () => {
    if (!teamId || !canInvite) return;
    setIsCreating(true);
    setError(null);
    try {
      const result = await createActorsApi({
        getAccessToken: supabaseAccessToken(supabase),
      }).createInvite({
        teamId,
        kind,
        displayName: name.trim(),
        teamRole: kind === "member" ? role : null,
        agentKind: kind === "agent" ? agentKind : null,
      });
      setInvite({
        token: result.token,
        deeplink: result.deeplink || buildDeeplink(result.token),
        expiresAt: result.expiresAt,
      });
    } catch (err) {
      if (err instanceof CloudApiError && err.code === "upgrade_required") {
        setNeedsUpgrade(true);
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : "Couldn't create invite.");
      }
    } finally {
      setIsCreating(false);
    }
  };

  const handleUpgrade = async () => {
    const trimmedOrg = orgName.trim();
    if (!teamId || trimmedOrg.length === 0 || isUpgrading) return;
    setIsUpgrading(true);
    setError(null);
    try {
      await createActorsApi({
        getAccessToken: supabaseAccessToken(supabase),
      }).upgradeAccount({ teamId, orgName: trimmedOrg, contact });
      // The team has its own org now, so the invite the user came here to make
      // will go through. Clear the prompt and let them retry.
      setNeedsUpgrade(false);
      setOrgName("");
      setContact("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "升级失败，请重试。");
    } finally {
      setIsUpgrading(false);
    }
  };

  const handleCopy = async () => {
    if (!invite) return;
    await Clipboard.setStringAsync(invite.deeplink);
    showToast("success", "Invite link copied");
  };

  const handleShare = async () => {
    if (!invite) return;
    try {
      await Share.share({ message: invite.deeplink });
    } catch {
      // user-cancelled or platform-level error — silent.
    }
  };

  return (
    <View style={styles.screen}>
      <GlassHeader>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>Invite</Text>
        <Pressable hitSlop={8} onPress={() => router.back()} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </GlassHeader>

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.section}>
          <SectionEyebrow label="KIND" style={styles.sectionEyebrow} />
          <View style={styles.segmented}>
            <SegmentChoice
              disabled={invite !== null}
              label="Teammate"
              onPress={() => setKind("member")}
              selected={kind === "member"}
            />
            <SegmentChoice
              disabled={invite !== null}
              label="Agent"
              onPress={() => setKind("agent")}
              selected={kind === "agent"}
            />
          </View>
        </View>

        <View style={styles.section}>
          <SectionEyebrow label="DISPLAY NAME" style={styles.sectionEyebrow} />
          <View style={styles.card}>
            <TextInput
              autoCapitalize="words"
              autoCorrect={false}
              editable={invite === null && !isCreating}
              maxLength={64}
              onChangeText={setName}
              placeholder={kind === "member" ? "Teammate's name" : "Agent's name"}
              placeholderTextColor={colors.slate}
              selectionColor={colors.cinnabar}
              style={styles.input}
              value={name}
            />
          </View>
        </View>

        {kind === "member" ? (
          <View style={styles.section}>
            <SectionEyebrow label="ROLE" style={styles.sectionEyebrow} />
            <View style={styles.segmented}>
              <SegmentChoice
                disabled={invite !== null}
                label="Member"
                onPress={() => setRole("member")}
                selected={role === "member"}
              />
              <SegmentChoice
                disabled={invite !== null}
                label="Admin"
                onPress={() => setRole("admin")}
                selected={role === "admin"}
              />
            </View>
          </View>
        ) : (
          <View style={styles.section}>
            <SectionEyebrow label="AGENT KIND" style={styles.sectionEyebrow} />
            <View style={styles.segmented}>
              <SegmentChoice
                disabled={invite !== null}
                label="Daemon"
                onPress={() => setAgentKind("daemon")}
                selected={agentKind === "daemon"}
              />
            </View>
          </View>
        )}

        {needsUpgrade ? (
          <View style={styles.section}>
            <SectionEyebrow label="升级账号" style={styles.sectionEyebrow} />
            <Text style={styles.upgradeHint}>
              当前团队还在公共组织下，只能自己使用。升级账号、创建你自己的团队后即可邀请成员。
            </Text>
            <View style={styles.card}>
              <TextInput
                editable={!isUpgrading}
                maxLength={64}
                onChangeText={setOrgName}
                placeholder="团队/组织名称"
                placeholderTextColor={colors.slate}
                style={styles.input}
                value={orgName}
              />
              <Hairline />
              <TextInput
                editable={!isUpgrading}
                maxLength={64}
                onChangeText={setContact}
                placeholder="联系方式（选填）"
                placeholderTextColor={colors.slate}
                style={styles.input}
                value={contact}
              />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: orgName.trim().length === 0 || isUpgrading }}
              disabled={orgName.trim().length === 0 || isUpgrading}
              onPress={() => {
                void handleUpgrade();
              }}
              style={({ pressed }) => [
                styles.upgradeButton,
                orgName.trim().length === 0 || isUpgrading
                  ? styles.upgradeButtonDisabled
                  : null,
                pressed ? styles.actionPressed : null,
              ]}
            >
              <Text style={styles.upgradeButtonLabel}>
                {isUpgrading ? "升级中…" : "升级账号"}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        {invite ? (
          <View style={styles.section}>
            <SectionEyebrow label="SHARE INVITE" style={styles.sectionEyebrow} />
            <View style={styles.card}>
              <Text selectable style={styles.deeplink}>
                {invite.deeplink}
              </Text>
              <Hairline />
              <View style={styles.actionRow}>
                <Pressable
                  accessibilityRole="button"
                  onPress={handleShare}
                  style={({ pressed }) => [
                    styles.actionButton,
                    pressed ? styles.actionPressed : null,
                  ]}
                >
                  <Ionicons color={colors.cinnabar} name="share-outline" size={18} />
                  <Text style={styles.actionLabel}>Share</Text>
                </Pressable>
                <View style={styles.actionDivider} />
                <Pressable
                  accessibilityRole="button"
                  onPress={handleCopy}
                  style={({ pressed }) => [
                    styles.actionButton,
                    pressed ? styles.actionPressed : null,
                  ]}
                >
                  <Ionicons color={colors.cinnabar} name="copy-outline" size={18} />
                  <Text style={styles.actionLabel}>Copy</Text>
                </Pressable>
              </View>
            </View>
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            disabled={!canInvite}
            onPress={handleCreate}
            style={({ pressed }) => [
              styles.cta,
              canInvite ? styles.ctaActive : styles.ctaInactive,
              pressed && canInvite ? styles.ctaPressed : null,
            ]}
          >
            {isCreating ? (
              <ActivityIndicator color={hai.paper} />
            ) : (
              <Text
                style={[
                  styles.ctaText,
                  canInvite ? styles.ctaTextActive : styles.ctaTextInactive,
                ]}
              >
                Create invite link
              </Text>
            )}
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

function SegmentChoice({
  disabled,
  label,
  onPress,
  selected,
}: {
  disabled?: boolean;
  label: string;
  onPress: () => void;
  selected: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.segmentChoice,
        selected ? styles.segmentChoiceSelected : null,
        disabled && !selected ? styles.segmentChoiceDisabled : null,
      ]}
    >
      <Text
        style={[
          styles.segmentChoiceLabel,
          selected ? styles.segmentChoiceLabelSelected : null,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  upgradeHint: {
    color: colors.basalt,
    paddingHorizontal: spacing.lg,
    ...typography.caption,
  },
  upgradeButton: {
    alignItems: "center",
    backgroundColor: colors.onyx,
    borderRadius: radii.pill,
    marginHorizontal: spacing.lg,
    paddingVertical: 12,
  },
  upgradeButtonDisabled: {
    opacity: 0.4,
  },
  upgradeButtonLabel: {
    color: colors.paper,
    ...typography.body,
    fontWeight: "600",
  },
  actionButton: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    paddingVertical: spacing.md,
  },
  actionDivider: {
    backgroundColor: colors.hairline,
    width: StyleSheet.hairlineWidth,
  },
  actionLabel: {
    color: colors.cinnabar,
    ...typography.body,
    fontWeight: "600",
  },
  actionPressed: {
    opacity: 0.6,
  },
  actionRow: {
    flexDirection: "row",
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
    paddingTop: GLASS_HEADER_HEIGHT + spacing.lg,
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
  deeplink: {
    color: colors.basalt,
    padding: spacing.md,
    ...typography.monoMeta,
  },
  errorText: {
    color: hai.cinnabarDeep,
    paddingHorizontal: spacing.xs,
    ...typography.caption,
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
  input: {
    color: colors.onyx,
    padding: spacing.md,
    ...typography.body,
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
  segmentChoice: {
    alignItems: "center",
    backgroundColor: hai.pebble,
    borderRadius: radii.pill,
    flex: 1,
    paddingVertical: 9,
  },
  segmentChoiceDisabled: {
    opacity: 0.5,
  },
  segmentChoiceLabel: {
    color: hai.basalt,
    ...typography.body,
    fontWeight: "600",
  },
  segmentChoiceLabelSelected: {
    color: hai.paper,
  },
  segmentChoiceSelected: {
    backgroundColor: hai.onyx,
  },
  segmented: {
    flexDirection: "row",
    gap: spacing.xs,
  },
});

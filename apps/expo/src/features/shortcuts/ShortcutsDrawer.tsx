import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import * as Linking from "expo-linking";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { createConfiguredShortcutsApi } from "./api-provider";
import {
  isLeafShortcut,
  type Shortcut,
  type ShortcutScope,
} from "./shortcut-types";
import { supabase } from "../../lib/supabase/client";
import { Hairline } from "../../ui/atoms/Hairline";
import { colors, hai, radii, spacing, typography } from "../../ui/theme";

export type ShortcutsDrawerProps = {
  isPresented: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenShortcut: (shortcut: Shortcut) => void;
  teamId: string;
  profileName: string;
  profileSubtitle?: string | null;
};

const ANIMATION_DURATION = 240;

/**
 * 1:1 port of `apps/ios/.../ShortcutsDrawer.swift`. Left-edge drawer:
 *   • Onyx-tinted backdrop (tap to close, drag-back closes via overlay press)
 *   • Profile header (avatar + name + subtitle)
 *   • Personal + Team scoped sections, loaded from Supabase
 *   • Settings footer at the bottom with app version
 *
 * Lifts the drawer surface so it cannot live as a separate route — the
 * sessions screen owns the open/close state and routes settings + shortcut
 * taps through the drawer back to the host so the host can dismiss us.
 */
export function ShortcutsDrawer({
  isPresented,
  onClose,
  onOpenSettings,
  onOpenShortcut,
  teamId,
  profileName,
  profileSubtitle,
}: ShortcutsDrawerProps) {
  const { width: screenWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const drawerWidth = Math.min(360, screenWidth * 0.86);

  // Off-screen on the left when closed; slides to 0 when open.
  const translateX = useRef(new Animated.Value(-drawerWidth)).current;
  const backdrop = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(isPresented);

  useEffect(() => {
    if (isPresented) {
      setMounted(true);
      Animated.parallel([
        Animated.timing(translateX, {
          toValue: 0,
          duration: ANIMATION_DURATION,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(backdrop, {
          toValue: 1,
          duration: ANIMATION_DURATION,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(translateX, {
          toValue: -drawerWidth,
          duration: ANIMATION_DURATION,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(backdrop, {
          toValue: 0,
          duration: ANIMATION_DURATION,
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [isPresented, drawerWidth, translateX, backdrop]);

  const [shortcuts, setShortcuts] = useState<Shortcut[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isPresented || !teamId) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    void (async () => {
      try {
        const rows = await createConfiguredShortcutsApi(supabase).listShortcuts(teamId);
        if (!cancelled) setShortcuts(rows);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Couldn't load shortcuts.",
          );
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isPresented, teamId]);

  if (!mounted) return null;

  const handleSettings = () => {
    onClose();
    setTimeout(() => onOpenSettings(), ANIMATION_DURATION + 16);
  };

  const handleOpenShortcut = (shortcut: Shortcut) => {
    onClose();
    setTimeout(() => onOpenShortcut(shortcut), ANIMATION_DURATION + 16);
  };

  const personalRoots = shortcuts
    .filter((row) => row.scope === "personal" && row.parentId === null)
    .sort((a, b) => a.order - b.order);
  const teamRoots = shortcuts
    .filter((row) => row.scope === "team" && row.parentId === null)
    .sort((a, b) => a.order - b.order);
  const isEmpty = personalRoots.length === 0 && teamRoots.length === 0;

  const appVersion = Constants.expoConfig?.version
    ? `v${Constants.expoConfig.version}`
    : null;

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <Animated.View
        pointerEvents={isPresented ? "auto" : "none"}
        style={[
          styles.backdrop,
          {
            opacity: backdrop.interpolate({
              inputRange: [0, 1],
              outputRange: [0, 0.22],
            }),
          },
        ]}
      >
        <Pressable
          accessibilityLabel="Close shortcuts"
          accessibilityRole="button"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>

      <Animated.View
        pointerEvents={isPresented ? "auto" : "none"}
        style={[
          styles.drawer,
          {
            paddingTop: insets.top,
            transform: [{ translateX }],
            width: drawerWidth,
          },
        ]}
      >
        <ProfileHeader
          displayName={profileName}
          subtitle={profileSubtitle ?? null}
        />

        <ScrollView
          contentContainerStyle={styles.listContent}
          style={styles.list}
        >
          {isLoading && isEmpty ? (
            <View style={styles.emptyState}>
              <ActivityIndicator color={colors.basalt} />
            </View>
          ) : isEmpty ? (
            <View style={styles.emptyState}>
              <Ionicons color={colors.basalt} name="star-outline" size={40} />
              <Text style={styles.emptyTitle}>No Shortcuts</Text>
              <Text style={styles.emptyBody}>
                Shortcuts you or your team create will appear here.
              </Text>
            </View>
          ) : (
            <>
              {personalRoots.length > 0 ? (
                <ShortcutSection
                  count={personalRoots.length}
                  onOpen={handleOpenShortcut}
                  rows={personalRoots}
                  title="Personal"
                />
              ) : null}
              {teamRoots.length > 0 ? (
                <ShortcutSection
                  count={teamRoots.length}
                  onOpen={handleOpenShortcut}
                  rows={teamRoots}
                  title="Team"
                />
              ) : null}
              {error ? <Text style={styles.errorText}>{error}</Text> : null}
            </>
          )}
        </ScrollView>

        <View style={styles.footer}>
          <Hairline />
          <Pressable
            accessibilityLabel="Settings"
            accessibilityRole="button"
            onPress={handleSettings}
            style={({ pressed }) => [
              styles.footerRow,
              pressed ? styles.footerRowPressed : null,
              { paddingBottom: 14 + Math.max(insets.bottom - 4, 0) },
            ]}
          >
            <Ionicons
              color={colors.basalt}
              name="settings-outline"
              size={18}
              style={styles.footerIcon}
            />
            <Text style={styles.footerLabel}>Settings</Text>
            <View style={styles.footerSpacer} />
            {appVersion ? (
              <Text style={styles.footerVersion}>{appVersion}</Text>
            ) : null}
            <Ionicons
              color={colors.slate}
              name="chevron-forward"
              size={14}
            />
          </Pressable>
        </View>
      </Animated.View>
    </View>
  );
}

function ProfileHeader({
  displayName,
  subtitle,
}: {
  displayName: string;
  subtitle: string | null;
}) {
  const initial = displayName.trim().charAt(0).toUpperCase() || "·";
  return (
    <View style={styles.profile}>
      <View style={styles.profileRow}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initial}</Text>
        </View>
        <View style={styles.profileBody}>
          <Text numberOfLines={1} style={styles.profileName}>
            {displayName}
          </Text>
          {subtitle ? (
            <Text numberOfLines={1} style={styles.profileSubtitle}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      </View>
      <Hairline style={styles.profileDivider} />
    </View>
  );
}

function ShortcutSection({
  count,
  onOpen,
  rows,
  title,
}: {
  count: number;
  onOpen: (shortcut: Shortcut) => void;
  rows: Shortcut[];
  title: string;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionHeader}>
        {title.toUpperCase()} · {count}
      </Text>
      <View>
        {rows.map((row) => (
          <ShortcutRow key={row.id} onOpen={onOpen} row={row} />
        ))}
      </View>
    </View>
  );
}

function ShortcutRow({
  onOpen,
  row,
}: {
  onOpen: (shortcut: Shortcut) => void;
  row: Shortcut;
}) {
  const iconName = iconForNode(row);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => onOpen(row)}
      style={({ pressed }) => [
        styles.shortcutRow,
        pressed ? styles.shortcutRowPressed : null,
      ]}
    >
      <View style={styles.shortcutIcon}>
        <Ionicons color={colors.basalt} name={iconName} size={15} />
      </View>
      <Text numberOfLines={1} style={styles.shortcutLabel}>
        {row.label}
      </Text>
      <View style={styles.footerSpacer} />
      {isLeafShortcut(row) ? (
        <Ionicons color={colors.slate} name="open-outline" size={14} />
      ) : (
        <Ionicons color={colors.slate} name="chevron-forward" size={14} />
      )}
    </Pressable>
  );
}

function iconForNode(
  row: Shortcut,
): React.ComponentProps<typeof Ionicons>["name"] {
  switch (row.nodeType) {
    case "folder":
      return "folder-outline";
    case "session":
      return "chatbubbles-outline";
    case "team":
      return "people-outline";
    case "external":
      return "link-outline";
    case "url":
    default:
      return "globe-outline";
  }
}

export async function openShortcutTarget(
  shortcut: Shortcut,
  router: {
    push: (href: string | { pathname: string; params: Record<string, string> }) => void;
  },
) {
  if (!shortcut.target) return;
  if (shortcut.nodeType === "session") {
    router.push(`/(app)/sessions/${shortcut.target}`);
    return;
  }
  if (shortcut.nodeType === "url" || shortcut.nodeType === "external") {
    router.push({
      pathname: "/(app)/shortcut-web",
      params: { url: shortcut.target, title: shortcut.label },
    });
    return;
  }
}

const styles = StyleSheet.create({
  avatar: {
    alignItems: "center",
    backgroundColor: hai.pebble,
    borderRadius: 22,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  avatarText: {
    color: colors.onyx,
    fontSize: 17,
    fontWeight: "600",
  },
  backdrop: {
    backgroundColor: colors.onyx,
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  drawer: {
    backgroundColor: colors.mist,
    borderRightColor: colors.hairline,
    borderRightWidth: StyleSheet.hairlineWidth,
    bottom: 0,
    left: 0,
    position: "absolute",
    top: 0,
  },
  emptyBody: {
    color: colors.basalt,
    paddingHorizontal: 16,
    textAlign: "center",
    ...typography.secondaryBody,
  },
  emptyState: {
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: 24,
    paddingTop: 56,
  },
  emptyTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
    fontSize: 17,
    fontWeight: "600",
  },
  errorText: {
    color: colors.slate,
    paddingHorizontal: 20,
    paddingTop: spacing.sm,
    ...typography.caption,
  },
  footer: {
    backgroundColor: colors.mist,
  },
  footerIcon: {
    paddingLeft: 18,
    width: 36,
  },
  footerLabel: {
    color: colors.onyx,
    paddingLeft: 6,
    ...typography.body,
    fontSize: 15,
  },
  footerRow: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: 50,
    paddingRight: 18,
    paddingTop: 14,
  },
  footerRowPressed: {
    backgroundColor: "rgba(34,32,29,0.04)",
  },
  footerSpacer: {
    flex: 1,
  },
  footerVersion: {
    color: colors.slate,
    paddingHorizontal: 6,
    ...typography.monoMeta,
  },
  list: {
    flex: 1,
  },
  listContent: {
    gap: 16,
    paddingBottom: 16,
    paddingTop: 16,
  },
  profile: {
    backgroundColor: colors.mist,
  },
  profileBody: {
    flex: 1,
    gap: 2,
  },
  profileDivider: {
    marginHorizontal: 20,
  },
  profileName: {
    color: colors.onyx,
    fontSize: 17,
    fontWeight: "600",
  },
  profileRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 14,
    paddingBottom: 14,
    paddingHorizontal: 20,
    paddingTop: 18,
  },
  profileSubtitle: {
    color: colors.slate,
    fontSize: 13,
  },
  section: {
    gap: 4,
  },
  sectionHeader: {
    color: colors.slate,
    fontFamily: typography.mono.fontFamily,
    fontSize: 10.5,
    fontWeight: "600",
    letterSpacing: 0.4,
    paddingBottom: 2,
    paddingHorizontal: 20,
    textTransform: "uppercase",
  },
  shortcutIcon: {
    alignItems: "center",
    paddingLeft: 18,
    width: 36,
  },
  shortcutLabel: {
    color: colors.onyx,
    paddingLeft: 6,
    ...typography.body,
    fontSize: 15,
  },
  shortcutRow: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: 44,
    paddingRight: 18,
    paddingVertical: 8,
  },
  shortcutRowPressed: {
    backgroundColor: "rgba(34,32,29,0.04)",
  },
});

import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useEffect, useState } from "react";
import { Platform, StyleSheet, type ColorValue } from "react-native";

import {
  getUnreadSessionCount,
  subscribeUnreadSessionCount,
} from "../../../src/features/sessions/unread-store";
import { GlassSurface } from "../../../src/ui/GlassSurface";
import { colors, typography } from "../../../src/ui/theme";

type TabIconProps = {
  // `ColorValue`, not `string`: this is what expo-router hands `tabBarIcon`,
  // and a `string` parameter makes the callback unassignable to the prop.
  color: ColorValue;
  focused: boolean;
  size: number;
};

type IconName = keyof typeof Ionicons.glyphMap;

function makeIcon(activeName: IconName, idleName: IconName) {
  return function TabIcon({ color, focused, size }: TabIconProps) {
    return (
      <Ionicons name={focused ? activeName : idleName} size={size} color={color} />
    );
  };
}

/**
 * Tab bar, split by platform.
 *
 * iOS gets a real `UITabBar` via `NativeTabs`; Android keeps the JS tab bar
 * with `GlassSurface` behind it. The split is not a stylistic preference — it
 * follows what each platform can actually do:
 *
 * `RootTabView.swift` draws **no glass of its own**. It is a stock SwiftUI
 * `TabView` with `.tabViewStyle(.sidebarAdaptable)`, and its Liquid Glass comes
 * entirely from iOS 26. So matching iOS means handing the bar to the system,
 * not painting a better imitation of it — a JS tab bar with a blur behind it
 * tops out well short, which is the gap that prompted this.
 *
 * Android has no Liquid Glass to inherit and `@expo/ui`'s Compose half is
 * announced rather than shipped, so `GlassSurface` (`dimezisBlurView` + tint)
 * remains the ceiling there. Switching Android to `NativeTabs` too would only
 * trade our Hai styling for Material 3 and gain nothing.
 */
export default function TabsLayout() {
  const [unread, setUnread] = useState(getUnreadSessionCount());
  useEffect(() => subscribeUnreadSessionCount((next) => setUnread(next)), []);

  if (Platform.OS === "ios") {
    return <IosNativeTabs unread={unread} />;
  }
  return <AndroidGlassTabs unread={unread} />;
}

/**
 * SF Symbols and roles are taken from `RootTabView.swift` rather than chosen —
 * the point is to be the same bar, so the symbol names match one for one.
 *
 * Deliberately no `blurEffect`: setting one applies a legacy `UIBlurEffect` and
 * **opts the bar out of Liquid Glass**, which is the opposite of the goal. The
 * default is what lets iOS 26 glaze it.
 */
function IosNativeTabs({ unread }: { unread: number }) {
  return (
    <NativeTabs
      // Mirrors `.tabViewStyle(.sidebarAdaptable)` on iOS.
      sidebarAdaptable
      tintColor={colors.cinnabar}
      badgeBackgroundColor={colors.cinnabar}
      // iOS 26: the bar shrinks out of the way as content scrolls under it.
      minimizeBehavior="onScrollDown"
    >
      <NativeTabs.Trigger name="sessions">
        <NativeTabs.Trigger.Icon sf="bubble.left.and.bubble.right" />
        <NativeTabs.Trigger.Label>Sessions</NativeTabs.Trigger.Label>
        {unread > 0 ? (
          <NativeTabs.Trigger.Badge>{String(unread)}</NativeTabs.Trigger.Badge>
        ) : null}
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="ideas">
        <NativeTabs.Trigger.Icon sf="lightbulb" />
        <NativeTabs.Trigger.Label>Ideas</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="actors">
        <NativeTabs.Trigger.Icon sf="person.2" />
        <NativeTabs.Trigger.Label>Actors</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      {/* iOS declares this one as `Tab(value:role: .search)` — on iOS 26 the
          search role is what splits it into its own glass pill beside the
          others, so the role matters more than the icon here. */}
      <NativeTabs.Trigger name="search" role="search">
        <NativeTabs.Trigger.Icon sf="magnifyingglass" />
        <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

function AndroidGlassTabs({ unread }: { unread: number }) {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.cinnabar,
        tabBarInactiveTintColor: colors.slate,
        tabBarLabelStyle: styles.label,
        // Transparent and absolutely positioned so content passes *under* the
        // bar — without that there is nothing for the blur to sample and the
        // glass reads as a flat fill. Screens make room via
        // `useTabContentBottomInset`.
        tabBarStyle: styles.bar,
        tabBarBackground: () => <GlassSurface style={styles.barBackground} />,
        sceneStyle: styles.scene,
      }}
    >
      <Tabs.Screen
        name="sessions"
        options={{
          title: "Sessions",
          tabBarBadge: unread > 0 ? unread : undefined,
          tabBarBadgeStyle: {
            backgroundColor: colors.cinnabar,
            color: colors.paper,
            fontSize: 10,
            fontWeight: "700",
          },
          tabBarIcon: makeIcon("chatbubbles", "chatbubbles-outline"),
        }}
      />
      <Tabs.Screen
        name="ideas"
        options={{
          title: "Ideas",
          tabBarIcon: makeIcon("bulb", "bulb-outline"),
        }}
      />
      <Tabs.Screen
        name="actors"
        options={{
          title: "Actors",
          tabBarIcon: makeIcon("people", "people-outline"),
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: "Search",
          tabBarIcon: makeIcon("search", "search-outline"),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: "transparent",
    borderTopColor: colors.hairline,
    borderTopWidth: StyleSheet.hairlineWidth,
    elevation: 0,
    position: "absolute",
  },
  barBackground: {
    // iOS's fallback pairs the material with a soft shadow rather than a hard
    // edge; the hairline above carries the boundary.
    shadowColor: colors.onyx,
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
  },
  label: {
    ...typography.monoMeta,
    fontSize: 10,
    letterSpacing: 0.4,
    marginTop: -2,
  },
  scene: {
    backgroundColor: colors.mist,
  },
});

import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, type ColorValue } from "react-native";

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

export default function TabsLayout() {
  const [unread, setUnread] = useState(getUnreadSessionCount());
  useEffect(() => subscribeUnreadSessionCount((next) => setUnread(next)), []);

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

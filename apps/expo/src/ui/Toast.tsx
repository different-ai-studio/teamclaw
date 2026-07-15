import { Ionicons } from "@expo/vector-icons";
import type { ComponentProps } from "react";
import { useEffect, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text } from "react-native";

import { colors, hai, radii, spacing, typography } from "./theme";

type IconName = ComponentProps<typeof Ionicons>["name"];

export type ToastKind = "success" | "info" | "error";

export type ToastDescriptor = {
  id: string;
  kind: ToastKind;
  message: string;
};

type Listener = (toast: ToastDescriptor) => void;

const listeners = new Set<Listener>();
let counter = 0;

export function showToast(kind: ToastKind, message: string): void {
  counter += 1;
  const toast: ToastDescriptor = { id: `toast-${counter}`, kind, message };
  for (const listener of listeners) listener(toast);
}

function iconForKind(kind: ToastKind): IconName {
  switch (kind) {
    case "success":
      return "checkmark-circle";
    case "error":
      return "alert-circle";
    case "info":
    default:
      return "information-circle";
  }
}

function tintForKind(kind: ToastKind): { fg: string; bg: string } {
  switch (kind) {
    case "success":
      return { fg: hai.sage, bg: "rgba(107,142,90,0.16)" };
    case "error":
      return { fg: hai.cinnabarDeep, bg: "rgba(184,75,54,0.16)" };
    case "info":
    default:
      return { fg: hai.basalt, bg: hai.pebble };
  }
}

/**
 * App-level toast host. Mount once near the root; calls to `showToast`
 * from anywhere in the tree append a transient banner that auto-
 * dismisses after 2.4s. Mirrors the iOS `BannerOverlay` pattern.
 */
export function ToastHost() {
  const [active, setActive] = useState<ToastDescriptor | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const listener: Listener = (toast) => {
      setActive(toast);
      Animated.timing(opacity, {
        toValue: 1,
        duration: 180,
        useNativeDriver: true,
      }).start();
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
      dismissTimer.current = setTimeout(() => {
        Animated.timing(opacity, {
          toValue: 0,
          duration: 240,
          useNativeDriver: true,
        }).start(() => setActive(null));
      }, 2400);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
    };
  }, [opacity]);

  if (!active) return null;
  const tint = tintForKind(active.kind);

  return (
    <Animated.View pointerEvents="box-none" style={[styles.host, { opacity }]}>
      <Pressable
        accessibilityRole="alert"
        onPress={() => {
          Animated.timing(opacity, {
            toValue: 0,
            duration: 160,
            useNativeDriver: true,
          }).start(() => setActive(null));
          if (dismissTimer.current) clearTimeout(dismissTimer.current);
        }}
        style={[styles.toast, { backgroundColor: tint.bg }]}
      >
        <Ionicons color={tint.fg} name={iconForKind(active.kind)} size={18} />
        <Text numberOfLines={2} style={[styles.message, { color: tint.fg }]}>
          {active.message}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  host: {
    left: 0,
    paddingHorizontal: spacing.lg,
    position: "absolute",
    right: 0,
    top: 64,
  },
  message: {
    flex: 1,
    ...typography.caption,
    fontWeight: "700",
  },
  toast: {
    alignItems: "center",
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 8,
    padding: 12,
  },
});

export default ToastHost;

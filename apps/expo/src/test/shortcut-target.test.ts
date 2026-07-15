import { describe, expect, it, vi } from "vitest";

// Mock React Native and Expo modules that cannot run in Node
vi.mock("react-native", () => ({
  StyleSheet: { create: (s: unknown) => s },
  Animated: { Value: class {}, timing: vi.fn(), spring: vi.fn() },
  Easing: {},
  Pressable: {},
  ScrollView: {},
  Text: {},
  View: {},
  ActivityIndicator: {},
  useWindowDimensions: () => ({ width: 375, height: 812 }),
}));
vi.mock("@expo/vector-icons", () => ({ Ionicons: {} }));
vi.mock("expo-constants", () => ({ default: { expoConfig: {} } }));
vi.mock("expo-linking", () => ({ canOpenURL: vi.fn(), openURL: vi.fn() }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../lib/supabase/client", () => ({ supabase: {} }));
vi.mock("../ui/atoms/Hairline", () => ({ Hairline: {} }));
vi.mock("../ui/theme", () => ({
  colors: { slate: "#888", text: "#000", bg: "#fff" },
  hai: { pebble: "#ccc", fog: "#eee", ink: "#111" },
  radii: { sm: 4, md: 8, lg: 16 },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24 },
  typography: {
    sans: { fontFamily: "System" },
    serif: { fontFamily: "System" },
    mono: { fontFamily: "Courier" },
    caption: { fontFamily: "System", fontSize: 12 },
    body: { fontFamily: "System", fontSize: 14 },
  },
}));
vi.mock("../features/shortcuts/api-provider", () => ({ createConfiguredShortcutsApi: vi.fn() }));

import { openShortcutTarget } from "../features/shortcuts/ShortcutsDrawer";
import type { Shortcut } from "../features/shortcuts/shortcut-types";

function shortcut(over: Partial<Shortcut>): Shortcut {
  return {
    id: "x", scope: "team", parentId: null, label: "X", nodeType: "url",
    target: "", order: 0, ...over,
  } as Shortcut;
}

describe("openShortcutTarget", () => {
  it("routes a session shortcut to the session route", async () => {
    const router = { push: vi.fn() };
    await openShortcutTarget(shortcut({ nodeType: "session", target: "session-123" }), router);
    expect(router.push).toHaveBeenCalledWith("/(app)/sessions/session-123");
  });

  it("routes a url shortcut to the in-app webview modal", async () => {
    const router = { push: vi.fn() };
    await openShortcutTarget(shortcut({ nodeType: "url", target: "https://example.com", label: "Hi" }), router);
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/(app)/shortcut-web",
      params: { url: "https://example.com", title: "Hi" },
    });
  });

  it("routes an external shortcut through the webview as well", async () => {
    const router = { push: vi.fn() };
    await openShortcutTarget(shortcut({ nodeType: "external", target: "https://example.com" }), router);
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/(app)/shortcut-web",
      params: { url: "https://example.com", title: "X" },
    });
  });
});

import { StyleSheet } from "react-native";

import { colors, typography } from "./theme";

/** Icon (24) + 10pt label + breathing room, close to UIKit's own 49. */
export const TAB_BAR_HEIGHT = 56;

/**
 * Whether the iOS `NativeTabs` bar should hide for this pathname.
 *
 * Session detail lives under the Sessions tab stack
 * (`(tabs)/sessions/[sessionId]`). On iOS the bar is a real UITabBar via
 * `NativeTabs`, which ignores the JS `tabBarStyle: { display: "none" }`
 * path Android uses — leave it up and it covers the composer. `NativeTabs`
 * exposes `hidden` for this; drive it from the path so the layout owns the
 * decision and session detail does not need a context round-trip.
 *
 * Matches `/sessions/<id>` only — the list (`/sessions`) keeps the bar.
 */
export function shouldHideNativeTabBar(pathname: string): boolean {
  return /^\/sessions\/[^/]+\/?$/.test(pathname);
}

/**
 * The Android tab bar's style, as one value that both the navigator and
 * anything which has to put it back can reach.
 *
 * It lives outside the layout because the session detail screen hides the bar
 * while it is open — `tabBarStyle: { display: "none" }` on the parent
 * navigator — and has to restore it on the way out. It used to restore it as
 * `undefined`, the obvious reading of "drop my override". That is not what it
 * does: React Navigation merges runtime options *over* `screenOptions`, so an
 * explicit `undefined` wins, and the Sessions tab came back with the library's
 * 49dp default bar and none of the styling below. Measured on device: 200px
 * before opening a session, 182px after — and the second one lasted until the
 * app restarted, so only the tab you had been reading in was wrong.
 *
 * Restoring the real thing is only safe if there is one of it.
 */
export function androidTabBarStyle(bottomInset: number) {
  return [
    styles.bar,
    { height: TAB_BAR_HEIGHT + bottomInset, paddingBottom: bottomInset },
  ];
}

export const tabBarLabelStyle = {
  ...typography.monoMeta,
  fontSize: 10,
  letterSpacing: 0.4,
  marginTop: -2,
} as const;

const styles = StyleSheet.create({
  bar: {
    backgroundColor: colors.paper,
    borderTopColor: colors.hairline,
    borderTopWidth: StyleSheet.hairlineWidth,
    // No elevation: the hairline carries the boundary, and Material's drop
    // shadow would read as a different design language next to Hai's flat
    // surfaces.
    elevation: 0,
  },
});

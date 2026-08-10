import { useContext } from "react";
// expo-router 57 vendors bottom-tabs rather than depending on the published
// package, and exposes no subpath for it — `@react-navigation/bottom-tabs` does
// not resolve from this app at all. This deep import is the only way to reach
// the height context. Isolated here so a restructure upstream is a one-line fix.
import { BottomTabBarHeightContext } from "expo-router/build/react-navigation/bottom-tabs";

/**
 * Bottom padding a tab screen needs so its last row can clear the tab bar.
 *
 * The bar is transparent and absolutely positioned so content passes under the
 * glass; that means nothing reserves space for it, and every scrolling tab
 * screen has to add this to its content inset — the same arrangement iOS uses,
 * where content scrolls under the bar and the scroll view carries the inset.
 *
 * Returns 0 outside a tab navigator, so a screen can use it unconditionally.
 *
 * **0 on iOS is correct, not a bug.** iOS runs `NativeTabs`, whose screens get
 * UIKit's automatic content-inset adjustment — the system reserves room for the
 * real tab bar itself. This context only exists under the JS `Tabs` navigator,
 * which is now Android-only. Adding a safe-area fallback here to "fix" the zero
 * would double-pad every iOS tab screen.
 */
export function useTabBarInset(): number {
  return useContext(BottomTabBarHeightContext) ?? 0;
}

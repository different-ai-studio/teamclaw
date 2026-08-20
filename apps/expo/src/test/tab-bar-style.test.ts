import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("react-native", () => ({
  Platform: { OS: "android", select: (values: Record<string, unknown>) => values.android ?? values.default },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 0.5 },
}));

const {
  androidTabBarStyle,
  shouldHideNativeTabBar,
  TAB_BAR_HEIGHT,
} = await import("../ui/tab-bar");

const SELF = path.resolve(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(path.dirname(SELF), "..", "..");
const TABS_LAYOUT = path.join(APP_ROOT, "app/(app)/(tabs)/_layout.tsx");

/**
 * `tabBarStyle: undefined` is the trap this file exists for.
 *
 * The session detail screen hides the tab bar by setting the parent
 * navigator's option, and restored it by setting that option to `undefined`.
 * React Navigation merges runtime options over `screenOptions`, so an explicit
 * `undefined` overrides rather than clears: coming back from a session left
 * the Sessions tab — and only that tab — with the library's 49dp default bar
 * and none of the Hai styling, until the app restarted. Measured on device at
 * 182px against 200px everywhere else.
 */
const CLEARED_TAB_BAR_STYLE = /tabBarStyle:\s*undefined/;
const NATIVE_TAB_BAR_HIDDEN = /hidden=\{hideTabBar\}/;
const NATIVE_TAB_BAR_PATH_HELPER = /shouldHideNativeTabBar/;

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry.name) && full !== SELF) {
      acc.push(full);
    }
  }
  return acc;
}

describe("android tab bar style", () => {
  it("is the bar height plus whatever the gesture pill claims", () => {
    const [, computed] = androidTabBarStyle(24) as [unknown, Record<string, number>];
    expect(computed.height).toBe(TAB_BAR_HEIGHT + 24);
    expect(computed.paddingBottom).toBe(24);
  });

  it("still paints the bar when the inset is zero", () => {
    const [bar, computed] = androidTabBarStyle(0) as [unknown, Record<string, number>];
    expect(bar).toBeDefined();
    expect(computed.height).toBe(TAB_BAR_HEIGHT);
  });

  it("catches the clear-by-undefined it was written for", () => {
    expect(CLEARED_TAB_BAR_STYLE.test("parent.setOptions({ tabBarStyle: undefined })")).toBe(true);
  });

  it("is never restored by clearing the option", () => {
    const offenders = walk(APP_ROOT)
      .filter((file) => CLEARED_TAB_BAR_STYLE.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(APP_ROOT, file));

    expect(
      offenders,
      "restore the tab bar with androidTabBarStyle(insets.bottom); `undefined` overrides screenOptions instead of falling back to it",
    ).toEqual([]);
  });
});

describe("native tab bar hide on session detail", () => {
  it("hides only on /sessions/<id>, not the list or other tabs", () => {
    expect(shouldHideNativeTabBar("/sessions")).toBe(false);
    expect(shouldHideNativeTabBar("/sessions/")).toBe(false);
    expect(shouldHideNativeTabBar("/ideas")).toBe(false);
    expect(shouldHideNativeTabBar("/actors")).toBe(false);
    expect(shouldHideNativeTabBar("/search")).toBe(false);
    expect(shouldHideNativeTabBar("/sessions/abc-123")).toBe(true);
    expect(shouldHideNativeTabBar("/sessions/abc-123/")).toBe(true);
    expect(shouldHideNativeTabBar("/sessions/abc-123/extra")).toBe(false);
  });

  it("wires NativeTabs.hidden from the pathname helper", () => {
    const layout = fs.readFileSync(TABS_LAYOUT, "utf8");
    expect(layout).toMatch(NATIVE_TAB_BAR_PATH_HELPER);
    expect(layout).toMatch(NATIVE_TAB_BAR_HIDDEN);
  });
});

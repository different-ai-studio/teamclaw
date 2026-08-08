# Expo app — CI coverage

## What CI runs

`pnpm test:expo` (the vitest suite, 342 tests) runs in the `Lint, Typecheck &
Test` job. Nothing else.

## What CI does not run, and why

**Typecheck is not gated.** `npx tsc --noEmit` in `apps/expo` reports 10
pre-existing errors. Turning the gate on means fixing these first:

| Count | File | Error |
|---|---|---|
| 9 | `src/features/shortcuts/ShortcutWebScreen.tsx` | every `<WebView>` prop: `not assignable to type 'never'` |
| 1 | `src/ui/SwipeableRow.tsx` | `Swipeable` is not exported by `react-native-gesture-handler` |

> ⚠️ **The `SwipeableRow` one is a live crash, not a type nit.** See below.

Root causes, so nobody has to re-derive them:

- **WebView (9).** `react-native-webview` exports
  `React.FunctionComponent<IOSWebViewProps & AndroidWebViewProps &
  WindowsWebViewProps>`. Props that differ across those three platforms
  intersect to `never`, so *every* prop fails. Setting
  `compilerOptions.moduleSuffixes` to resolve `.ios`/`.native` declarations —
  the usual fix — was tried and **made it worse** (15 errors: it broke
  `src/ui/button.tsx` too). The remaining options are upgrading
  `react-native-webview` past its React 19 support gap, or a narrow documented
  cast at the call site.
- **SwipeableRow (1) — this is a production crash.**
  `react-native-gesture-handler@3.0.0` removed `Swipeable` from its exports
  **at runtime**, not just from its types. So
  `import { Swipeable } from "react-native-gesture-handler"` binds `undefined`,
  and `<Swipeable>` throws *Element type is invalid* the moment it renders.

  `IdeasListScreen` renders `<SwipeableRow enabled={!selectionMode &&
  !!onArchiveBatch} trailingActions={[{ label: "Archive", … }]}>`, and
  `SwipeableRow` only short-circuits to a plain `<View>` when it is disabled or
  has no actions — so with archiving available, **the Ideas list crashes**. No
  test covers `SwipeableRow` or `IdeasListScreen`, which is why the suite is
  green anyway.

  The obvious replacement, `ReanimatedSwipeable` (at
  `react-native-gesture-handler/ReanimatedSwipeable`), is **not** a drop-in:
  `react-native-reanimated` is not a dependency, is not in `node_modules`, and
  `babel.config.js` has no reanimated plugin — all three are required. So the
  choice is either adopting reanimated (a native dependency, needs a device
  build to verify) or reimplementing the swipe on RNGH's `Gesture` /
  `GestureDetector` with RN `Animated`. Either way it needs on-device
  verification, not just a green `tsc`.

**Lint is not gated** either — the app has no ESLint config of its own, and the
root `pnpm lint` is scoped to `@teamclaw/app`.

## Why this matters

Everything here was invisible until 2026-08. The root `lint` / `typecheck` /
`test:unit` scripts are all `--filter @teamclaw/app`, so this app's suite had
never run in CI at all. The OAuth redirect bug that broke every Google and
Apple sign-in (`teamclaw://auth/callback` vs the allow-listed
`teamclaw://auth-callback`) sat here undetected, with test fixtures that
asserted the *broken* value.

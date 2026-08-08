# Expo app — CI coverage

## What CI runs

`pnpm test:expo` (the vitest suite, 342 tests) runs in the `Lint, Typecheck &
Test` job. Nothing else.

## What CI does not run, and why

**Typecheck is not gated.** `npx tsc --noEmit` in `apps/expo` reports 9
remaining errors, all in one file. Turning the gate on means fixing these:

| Count | File | Error |
|---|---|---|
| 9 | `src/features/shortcuts/ShortcutWebScreen.tsx` | every `<WebView>` prop: `not assignable to type 'never'` |

Root cause, so nobody has to re-derive it:

- **WebView (9).** `react-native-webview` exports
  `React.FunctionComponent<IOSWebViewProps & AndroidWebViewProps &
  WindowsWebViewProps>`. Props that differ across those three platforms
  intersect to `never`, so *every* prop fails. Setting
  `compilerOptions.moduleSuffixes` to resolve `.ios`/`.native` declarations —
  the usual fix — was tried and **made it worse** (15 errors: it broke
  `src/ui/button.tsx` too). The remaining options are upgrading
  `react-native-webview` past its React 19 support gap, or a narrow documented
  cast at the call site.
## Fixed here (kept as a record)

`SwipeableRow` used to import `Swipeable` from `react-native-gesture-handler`,
which **Gesture Handler 3 removed at runtime**, not just from its types — so
the import bound `undefined` and `<Swipeable>` threw *Element type is invalid*
on render. `IdeasListScreen` reaches it whenever archiving is available, so the
Ideas list crashed. Nothing caught it: no test covered `SwipeableRow` or
`IdeasListScreen`, and the app was outside CI entirely.

It is now built on the v3 pan API (`usePanGesture` + `GestureDetector`) with
React Native's own `Animated`, so it needs no `react-native-reanimated` — that
package is absent from `package.json`, from `node_modules`, and from
`babel.config.js`, so `ReanimatedSwipeable` was never a drop-in replacement.

Two things worth knowing if you touch it:

- The snap decision lives in `src/ui/swipeable-row-rest.ts`, deliberately free
  of React and `@expo/vector-icons`. Importing the component from a test drags
  in the icon set, which does not resolve under vitest's node environment — and
  a test file that fails to *load* takes unrelated suites down with it.
- **The gesture feel is unverified.** The rest-position rules are unit-tested,
  but thresholds, scroll arbitration (`activeOffsetX` / `failOffsetY`) and the
  spring need a device.

**Lint is not gated** either — the app has no ESLint config of its own, and the
root `pnpm lint` is scoped to `@teamclaw/app`.

## Why this matters

Everything here was invisible until 2026-08. The root `lint` / `typecheck` /
`test:unit` scripts are all `--filter @teamclaw/app`, so this app's suite had
never run in CI at all. The OAuth redirect bug that broke every Google and
Apple sign-in (`teamclaw://auth/callback` vs the allow-listed
`teamclaw://auth-callback`) sat here undetected, with test fixtures that
asserted the *broken* value.

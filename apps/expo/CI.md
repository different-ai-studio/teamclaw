# Expo app — CI coverage

## What CI runs

`pnpm test:expo` (the vitest suite, 342 tests) runs in the `Lint, Typecheck &
Test` job. Nothing else.

## What CI does not run, and why

**Typecheck is not gated.** `npx tsc --noEmit` in `apps/expo` currently reports
14 errors, all pre-existing. Turning the gate on means fixing these first:

| Count | File | Error |
|---|---|---|
| 9 | `src/features/shortcuts/ShortcutWebScreen.tsx` | every `<WebView>` prop: `not assignable to type 'never'` |
| 4 | `app/(app)/(tabs)/_layout.tsx` | tab `tabBarIcon`: `ColorValue` vs `string` |
| 1 | `src/ui/SwipeableRow.tsx` | `Swipeable` is not exported by `react-native-gesture-handler` |

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
- **SwipeableRow (1).** `react-native-gesture-handler@3.0.0` removed the legacy
  `Swipeable`. `ReanimatedSwipeable` exists at
  `react-native-gesture-handler/ReanimatedSwipeable`. This one is cheap: the
  local `renderRightActions` takes no arguments, so it needs only an import
  change, not a signature migration.
- **Tab icons (4).** Widen the local `TabIconProps.color` from `string` to
  `ColorValue`.

**Lint is not gated** either — the app has no ESLint config of its own, and the
root `pnpm lint` is scoped to `@teamclaw/app`.

## Why this matters

Everything here was invisible until 2026-08. The root `lint` / `typecheck` /
`test:unit` scripts are all `--filter @teamclaw/app`, so this app's suite had
never run in CI at all. The OAuth redirect bug that broke every Google and
Apple sign-in (`teamclaw://auth/callback` vs the allow-listed
`teamclaw://auth-callback`) sat here undetected, with test fixtures that
asserted the *broken* value.

# Expo app — CI coverage

## What CI runs

In the `Lint, Typecheck & Test` job:

- `pnpm typecheck:expo` — `tsc --noEmit`, currently clean
- `pnpm test:expo` — the vitest suite

## What CI does not run

**Lint.** The app has no ESLint config of its own, and the root `pnpm lint` is
scoped to `@teamclu/app`.

**Anything requiring a device or a native build.** Nothing here exercises
gestures, navigation, or the native modules — see the caveat on `SwipeableRow`
below.

## Why this exists

Until 2026-08 the root `lint` / `typecheck` / `test:unit` scripts were *all*
`--filter @teamclu/app`, so this app was in the workspace but outside every
gate — its tests had never run in CI, and `tsc` had drifted to 14 errors.

That gap was not theoretical. The OAuth redirect bug that silently broke every
Google and Apple sign-in (`teamclu://auth/callback` against the allow-listed
`teamclu://auth-callback`) lived here undetected, with test fixtures that
asserted the *broken* value.

## The suite needs Node ≥ 24

`src/test/helpers/memory-db.ts` runs the cache tests against a real database
via `node:sqlite`, so the schema, constraints and ordering under test are
SQLite's own rather than a fake's. That built-in does not exist before Node
22.5 and stays behind `--experimental-sqlite` until 23.4.

The `Lint, Typecheck & Test` job was pinned to Node 20 while every other
workflow used `lts/*`. The moment these tests landed, four suites — `session-cache`,
`session-detail-cache`, `streaming-snapshot`, `team-cache` — failed at *import*
with `No such built-in module: node:sqlite`, reddening CI on main for three
commits. A suite that fails to load takes its whole file down, so the failure
read as four broken features rather than one missing runtime.

CI is now on `lts/*` and the root `engines.node` says `>=24.0.0`, so a dev on an
older Node gets a warning at install rather than that error at test time.

## Two fixes worth keeping a record of

### `<WebView>` — every prop was `never`

`react-native-webview@14`'s `types` field points at its **package-root**
`index.d.ts`, not the correct one at `lib/index.d.ts`. The root file declares:

```ts
declare class WebView<P = undefined> extends Component<WebViewProps & P>
```

so the default instantiation has props of `WebViewProps & undefined` — that is,
`never` — and *every* prop fails to typecheck, along with the ref type. This is
an upstream declaration bug, not a platform-types problem.

`ShortcutWebScreen` supplies the parameter explicitly (`WebView<object>`,
restoring `WebViewProps & object`). Drop that once the package fixes its root
declaration or repoints `types` at `lib/`.

> Setting `compilerOptions.moduleSuffixes` to resolve `.ios`/`.native`
> declarations looks like the fix for this and **is not** — it was tried and
> made things worse (15 errors; it also broke `src/ui/button.tsx`).

### `SwipeableRow` — the Ideas list crashed

It imported `Swipeable` from `react-native-gesture-handler`, which Gesture
Handler 3 removed **at runtime**, not just from its types. The binding was
`undefined`, so `<Swipeable>` threw *Element type is invalid* on render, and
`IdeasListScreen` reaches it whenever archiving is available.

It is now built on the v3 pan API (`usePanGesture` + `GestureDetector`, both
re-exported from the package root via `export * from './v3'`) driving React
Native's own `Animated`. Deliberately not `ReanimatedSwipeable`, which needs
`react-native-reanimated` — absent from `package.json`, from `node_modules`,
and from `babel.config.js`.

Two things to know before touching it:

- The snap decision lives in `src/ui/swipeable-row-rest.ts`, kept free of React
  and `@expo/vector-icons` so it can be unit-tested. Importing the component
  from a test drags in the icon set, which does not resolve under vitest's node
  environment — and a test file that fails to *load* takes unrelated suites
  down with it.
- **The gesture feel is unverified.** The rest-position rules have tests, but
  thresholds, scroll arbitration (`activeOffsetX` / `failOffsetY`) and the
  spring need a device.

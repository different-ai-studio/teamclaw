# Expo app — error reporting

Sentry project: [`ucar-inc/teamclu-expo`](https://ucar-inc.sentry.io/projects/teamclu-expo/).
One React Native project covers both Android and iOS.

> The slug really is `teamclu-expo`, not `teamclaw-expo`. If it is ever renamed,
> update `organization`/`project` in the `@sentry/react-native` plugin entry in
> `app.json` — the DSN keeps working, but source map upload breaks.

## What reports, and when

| Build | Reports? |
|---|---|
| `expo start` (dev client) | No — set `EXPO_PUBLIC_SENTRY_DEBUG=1` to force it on |
| `preview` / `production` EAS build | Yes |

Dev is off by default because hot reload turns half-finished code into real
events: a missing import throws at module scope on every save, and that noise
lands in the same project as production traffic.

Errors only — `tracesSampleRate: 0`. Tracing costs battery and quota and we have
no latency question worth paying for yet.

## Source maps

A production bundle is minified, so without source maps every stack frame reads
as `index.android.bundle:1:284915`. Three pieces make symbolication work, and
all three are already wired:

1. `metro.config.js` builds from `getSentryExpoConfig`, whose serializer stamps
   a **debug ID** into both the bundle and its map. That ID is what matches a
   crash to the right map — not the release name, which is why upgrading the
   Metro config mattered more than it looks.
2. The `@sentry/react-native` config plugin in `app.json` writes
   `sentry.properties` with the org and project, so the upload knows where to go.
3. `@sentry/cli` is allowed to run its postinstall via `onlyBuiltDependencies`
   in the **root** `package.json`. pnpm 10 blocks install scripts by default, and
   a blocked one leaves the CLI binary missing — the upload then fails at build
   time rather than at install time.
4. `@sentry/cli` is also a **direct dependency of this app**, pinned to the exact
   version `@sentry/react-native` asks for, even though nothing here imports it.

   Sentry's Gradle integration shells out to a hardcoded
   `<project>/node_modules/@sentry/cli/bin/sentry-cli`, which assumes npm/yarn
   hoisting. pnpm keeps transitive dependencies out of the consumer's
   `node_modules`, so that path did not exist and the build died with
   `A problem occurred starting process` after having already written the bundle
   and its source map. Declaring it directly makes pnpm symlink it into place.

   If the pin ever drifts from `@sentry/react-native`'s own dependency, pnpm
   installs two copies and the Gradle task may run the wrong one.

### The one manual step: `SENTRY_AUTH_TOKEN`

Uploading needs a token, which is **not** in this repo and must not be. It is
also not the same thing as `EXPO_TOKEN`.

1. Create an **organization auth token** at
   Settings → Auth Tokens (scope: `project:releases`).
2. Give it to EAS as a secret, so cloud builds can upload. Run from
   `apps/expo/`. There is no global `eas` and the repo does not depend on
   `eas-cli`, so invoke it through `npx`:

   ```sh
   npx eas-cli@latest env:set --name SENTRY_AUTH_TOKEN --value <token> \
     --visibility secret --environment preview --environment production
   ```

   Use `env:set`, not `env:create` — the latter is deprecated as of eas-cli 21.

Until that exists, builds still succeed and errors still report — only the
stack traces stay minified.

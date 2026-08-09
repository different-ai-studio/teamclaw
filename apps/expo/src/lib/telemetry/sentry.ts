import Constants from "expo-constants";
import { Platform } from "react-native";

/**
 * Sentry bootstrap for the Expo app.
 *
 * This surface ran unmonitored while every other client reported: the Ideas
 * list crashed on render, OAuth sign-in dropped users back on the welcome
 * screen, and `/v1/auth/refresh` broke startup for anyone with a team — none
 * of it visible until someone drove the app by hand.
 *
 * Grouping rule, same as `packages/app/src/lib/telemetry/capture.ts`: never
 * interpolate ids, durations, or raw reasons into a message. Sentry
 * fingerprints on message text, so an embedded UUID shatters one problem into
 * dozens of issues. Ids belong in tags/extra.
 */

/**
 * Public by design — the DSN ships inside every client bundle and only grants
 * the ability to submit events. It is read from the environment anyway so the
 * value is not duplicated across `.env`, `eas.json`, and the source tree.
 */
const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN ?? "";

/**
 * Report from a dev build too. Off by default: hot reload turns half-finished
 * code into real events (a missing import throws at module scope on every
 * save), and that noise lands in the same project as production traffic.
 *
 * Set it to verify the pipeline end-to-end without waiting on an EAS build.
 */
const DEBUG_REPORTING = process.env.EXPO_PUBLIC_SENTRY_DEBUG === "1";

let started = false;

export function initSentry(): void {
  // Without a DSN the SDK still installs global handlers and queues events it
  // can never send, so skip entirely. Contributors without the var configured
  // get an app that behaves identically, minus reporting.
  if (started || !DSN) return;
  started = true;

  const Sentry = require("@sentry/react-native") as typeof import("@sentry/react-native");

  Sentry.init({
    dsn: DSN,
    enabled: !__DEV__ || DEBUG_REPORTING,
    environment: __DEV__ ? "development" : "production",
    // Matches the desktop `teamclaw-web@<version>` convention so releases line
    // up across projects.
    release: `teamclaw-expo@${Constants.expoConfig?.version ?? "0.0.0"}`,
    // Errors only for now. Tracing on mobile costs battery and quota, and we
    // have no latency question worth paying for yet.
    tracesSampleRate: 0,
    sendDefaultPii: false,
  });

  Sentry.setTag("platform.os", Platform.OS);
}

/**
 * Wraps the root component for native crash + navigation instrumentation.
 * A no-op when Sentry never started, so the tree is unchanged in dev.
 */
export function wrapRoot<T>(component: T): T {
  if (!started) return component;
  const Sentry = require("@sentry/react-native") as typeof import("@sentry/react-native");
  return Sentry.wrap(component as never) as T;
}

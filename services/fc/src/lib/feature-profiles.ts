// Per-deployment feature flags handed to clients at runtime.
//
// These live in the repo, not in an env var, because they must survive a
// deploy. On Alibaba FC `s deploy` REWRITES the function's whole environment
// map, so a var missing from the deploying machine's env file is not "keep the
// current value" — it is "wipe it". That is how belayo shipped a bootstrap with
// no broker twice (see the MQTT_BROKER_URL guard in deploy-aliyun-fc.sh). A
// login method that vanishes on the next unrelated deploy is the same failure
// with a worse blast radius, so the durable copy is here, in git, reviewable.
//
// They are a TypeScript module rather than JSON files on purpose: the container
// image only copies `dist/` (services/fc/Dockerfile), while the FC package ships
// the whole directory (`code: ./` in s.yaml). A data file would therefore work
// on one target and silently vanish on the other — the worst shape of bug,
// since a missing profile is indistinguishable from an empty one at the client.
// Compiled into dist/, both targets get it for free.
//
// `APP_FEATURES_JSON` still overrides these at runtime for emergencies. On
// belayo that override is lost at the next deploy; on self-host it lives in the
// box's .env and persists. Neither is the place for a durable decision.

export interface AuthFeatureFlags {
  google?: boolean;
  wechat?: boolean;
  phone?: boolean;
  password?: boolean;
  /**
   * ANDed with the client's build flag, never simply overriding it: the allowed
   * admin-console hosts are compiled into the desktop binary, so turning this on
   * server-side cannot on its own make it work — and must not be able to.
   */
  webSSO?: boolean;
}

export interface ChannelFeatureFlags {
  discord?: boolean;
  feishu?: boolean;
  email?: boolean;
  kook?: boolean;
  wecom?: boolean;
  wechat?: boolean;
}

export interface FeatureFlags {
  auth?: AuthFeatureFlags;
  channels?: ChannelFeatureFlags;
  teamShareBrowser?: boolean;
  apps?: boolean;
  /**
   * Locks a build out of changing or leaving the team LLM config. Kept at
   * DEPLOYMENT scope, matching what it already meant as a build-config flag
   * (`team.lockLlmConfig`, i.e. per brand). Making it per-team is a product
   * change and a schema change, not a config move — see the follow-up note
   * in docs/plans/2026-08-05-remote-feature-flags.md.
   */
  lockLlmConfig?: boolean;
}

/**
 * Selected by `APP_FEATURES_PROFILE`. One profile per RUNNING Cloud API, not
 * per brand — though today each deployment happens to serve one brand:
 *
 *   self-host   api.teamclaw-dev.ucar.cc     official TeamClaw
 *                                            (build.config.production.json)
 *   belayo      teamclaw-api.ucar.cc         betly
 *                                            (branding repo brands/betly)
 *   copilot361  copilot.accounting.i.test.shopee.io
 *                                            (branding repo brands/copilot361)
 *
 * Only docker-compose.yml defaults the name (`self-host` — that box is exactly
 * one environment). s.yaml deliberately has NO default, because it deploys both
 * belayo and copilot361 and a default would be the wrong brand's flags for one
 * of them. Unset means "no overrides", which is always safe.
 *
 * Each profile below RESTATES what that brand's build config already bakes, so
 * turning this on changes nothing: the server tells every client exactly what
 * it already believed. From here a flag is changed by editing this file — the
 * client no longer has to be repackaged.
 *
 * Keep them in sync when a brand's build config changes. They are defaults on
 * one side and overrides on the other; drift shows up as a flag that flips the
 * moment the network answers, which is confusing to debug and trivial to avoid.
 *
 * Two things you cannot express here, both by design:
 *   - `updater` (build-time only — a remote mistake is unrecoverable)
 *   - `auth.webSSOHosts` (compiled into the desktop binary)
 * `auth.webSSO` can be turned OFF here but not ON: the client ANDs it with the
 * build flag.
 */
export const FEATURE_PROFILES: Record<string, FeatureFlags> = {
  // Mirrors build.config.production.json (in this repo).
  "self-host": {
    auth: { google: true, wechat: false, phone: false, password: false, webSSO: false },
    channels: { discord: true, feishu: true, email: true, kook: true, wecom: true, wechat: true },
    teamShareBrowser: false,
    apps: false,
    lockLlmConfig: false,
  },

  // Mirrors the branding repo's brands/betly/build.config.json. `webSSO: true`
  // holds only because that build also bakes it on, together with
  // `webSSOHosts: ["admin.mx5.cn"]`.
  belayo: {
    auth: { google: false, wechat: false, phone: true, password: false, webSSO: true },
    channels: { discord: true, feishu: true, email: true, kook: true, wecom: true, wechat: true },
    teamShareBrowser: false,
    apps: false,
    lockLlmConfig: false,
  },

  // Mirrors the branding repo's brands/copilot361/build.config.json, which
  // carries no `auth` block at all — every alternative sign-in method is off and
  // only email OTP remains. Restated explicitly here so it is a decision on the
  // record rather than an omission.
  copilot361: {
    auth: { google: false, wechat: false, phone: false, password: false, webSSO: false },
    channels: { discord: true, feishu: true, email: true, kook: true, wecom: true, wechat: true },
    teamShareBrowser: false,
    apps: false,
    lockLlmConfig: false,
  },
};

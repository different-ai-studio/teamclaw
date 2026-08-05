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
 * Selected by `APP_FEATURES_PROFILE`. Both deploy definitions declare a
 * non-empty default for it (`self-host` in docker-compose.yml, `belayo` in
 * s.yaml), so an operator who sets nothing still gets the right profile.
 *
 * Both start EMPTY, which means "no overrides — every client keeps its baked
 * build config". That is deliberate: shipping this machinery must not change
 * any client's behaviour on day one. Add keys as decisions are actually made.
 *
 * One caveat before adding any: a profile applies to EVERY brand pointing at
 * this Cloud API, not just the one you have in mind. If two brands share a
 * deployment and want different answers, the endpoints already accept a `brand`
 * query param — key off it rather than flipping a flag for everyone.
 */
export const FEATURE_PROFILES: Record<string, FeatureFlags> = {
  "self-host": {},
  belayo: {},
};

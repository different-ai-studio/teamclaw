import { ApiError } from "../http-utils.js";

// `share_mode` is now a switch, not a choice. The column, the enum and this
// field keep their historical names — the value that means "on" is `oss`
// because that is the only one every existing client already understands:
// `normalizeShareStatus` in packages/app/src/stores/team-share.ts collapses an
// unrecognised value to `mode: null`, which renders an enabled team as
// "not set up" and reopens the onboarding wizard.
const SHARE_MODE_ON = "oss";

function validateShareModeInput(body) {
  const mode = body?.mode;
  // Accepting only the enabled value keeps the endpoint honest about what it
  // can actually do; a client still asking for a git mode gets told, rather
  // than getting a team configured for a backend that no longer exists.
  if (mode !== undefined && mode !== SHARE_MODE_ON) {
    throw new ApiError(
      400,
      "validation_failed",
      `mode must be "${SHARE_MODE_ON}" — git share modes are no longer supported`,
    );
  }
  return { mode: SHARE_MODE_ON, gitConfig: null };
}

function validateLlmConfigInput(body) {
  const enabled = body?.enabled;
  if (typeof enabled !== "boolean") {
    throw new ApiError(400, "validation_failed", "enabled must be a boolean");
  }
  let baseUrl = null;
  if (body.baseUrl !== undefined && body.baseUrl !== null) {
    if (typeof body.baseUrl !== "string") {
      throw new ApiError(400, "validation_failed", "baseUrl must be a string or null");
    }
    baseUrl = body.baseUrl.trim() || null;
  }
  const rawModels = body?.models;
  if (!Array.isArray(rawModels)) {
    throw new ApiError(400, "validation_failed", "models must be an array of {id,name}");
  }
  const models = rawModels.map((m) => {
    if (!m || typeof m !== "object" || typeof m.id !== "string" || typeof m.name !== "string") {
      throw new ApiError(400, "validation_failed", "each model must be an object with string id and name");
    }
    return { id: m.id, name: m.name };
  });
  return { enabled, baseUrl, models };
}

function isLockViolation(err) {
  if (!err) return false;
  if (err.code === "check_violation") return true;
  const msg = err.message || "";
  return /locked|already.*share_mode/i.test(msg);
}

export function registerTeamShare(router) {
  router.post("/v1/teams/:teamId/share-mode", async (ctx) => {
    const { mode, gitConfig } = validateShareModeInput(ctx.json ?? {});
    try {
      const team = await ctx.repository.enableShareMode(
        ctx.params.teamId,
        mode,
        gitConfig,
      );
      return { body: team };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (isLockViolation(err)) {
        throw new ApiError(
          409,
          "share_mode_locked",
          err.message || "Team share mode is already locked",
          { cause: err },
        );
      }
      throw err;
    }
  });

  router.get("/v1/teams/:teamId/share-mode", async (ctx) => {
    const result = await ctx.repository.getShareMode(ctx.params.teamId);
    return { body: result };
  });

  router.delete("/v1/teams/:teamId/share-mode", async () => {
    // Turning sync off would leave every member holding a half-synced tree with
    // no way to reconcile it, and the DB trigger refuses to clear the column
    // anyway. Say so instead of failing deeper down.
    throw new ApiError(
      410,
      "share_mode_permanent",
      "Team knowledge sync cannot be disabled once enabled",
    );
  });

  router.get("/v1/teams/:teamId/workspace-config", async (ctx) => {
    const result = await ctx.repository.getWorkspaceConfig(ctx.params.teamId);
    return { body: result };
  });

  router.put("/v1/teams/:teamId/llm-config", async (ctx) => {
    const input = validateLlmConfigInput(ctx.json ?? {});
    const result = await ctx.repository.setLlmConfig(ctx.params.teamId, input);
    return { body: result };
  });
}

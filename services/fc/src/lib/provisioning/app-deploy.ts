import { randomBytes } from "node:crypto";
import { ensureAppSchema } from "./app-postgres.js";
import { ApiError } from "../http-utils.js";

export function appFunctionName(appId: string): string { return `tc-app-${appId}`; }
export function appOssObjectName(appId: string): string { return `apps/${appId}/code.zip`; }

/**
 * 503 for a deploy attempt on a deployment that cannot provision.
 *
 * `reason` comes from makeDeployDeps and names the empty variable. Without it
 * this answered a bare "deploy provisioning not configured", which is what the
 * user saw in a toast and what got written into `apps.provision_error` — true,
 * and useless for finding out which of APPS_ACCESS_KEY_ID / APPS_OSS_BUCKET /
 * APPS_FC_ENDPOINT was the empty one.
 */
export function deployUnavailable(reason?: string): ApiError {
  return new ApiError(
    503,
    "deploy_unavailable",
    reason ? `deploy provisioning not configured: ${reason}` : "deploy provisioning not configured",
  );
}

// --- Deploy is two calls with a daemon build in between:
//
//   startDeploy  → mint the OSS upload handle; the daemon builds and PUTs there
//   finalizeDeploy → provision the schema, point the function at the uploaded
//                    code with a matching DATABASE_URL, ensure the HTTP trigger
//
// The FC function is created in finalize, NOT in startDeploy. Creating it first
// meant CreateFunction referenced an OSS object the daemon had not uploaded yet,
// and it also forced finalize into a code-only update that had to assume FC
// preserved the environment it could no longer see. Doing both in one step at
// finalize means the code object always exists and the env is always written
// alongside the password that was just set.

export interface StartDeployDeps {
  mintUploadUrl: (ossObjectName: string) => Promise<string>;
}
export interface StartDeployInput { appId: string; region: string; }
export interface StartDeployResult {
  fcFunctionName: string; fcRegion: string; ossObjectName: string; presignedPut: string;
}

export async function startDeploy(deps: StartDeployDeps, input: StartDeployInput): Promise<StartDeployResult> {
  const ossObjectName = appOssObjectName(input.appId);
  const presignedPut = await deps.mintUploadUrl(ossObjectName);
  return {
    fcFunctionName: appFunctionName(input.appId),
    fcRegion: input.region,
    ossObjectName,
    presignedPut,
  };
}

export interface FinalizeDeps {
  /** Absent when apps Postgres is unconfigured — only `data_app` needs it. */
  adminExec?: (sql: string) => Promise<void>;
  fcOps: {
    ensureFunction: (name: string, a: { ossObjectName: string; env: Record<string, string> }) => Promise<void>;
    ensureHttpTrigger: (name: string) => Promise<string>;
  };
  appsBaseUrl?: string;
  genPassword?: () => string;
}
export interface FinalizeInput {
  appId: string;
  slug: string;
  /** `static_web` / `slides` / `data_app`. Unknown values mean `data_app` —
   *  that is what every app created before types existed actually is. */
  appType: string;
  fcFunctionName: string;
  ossObjectName: string;
}

/** Only data apps get a Postgres schema; the other types are static files. */
export function needsDatabase(appType: string): boolean {
  const t = appType.trim();
  return t !== "static_web" && t !== "slides";
}

export async function finalizeDeploy(deps: FinalizeDeps, input: FinalizeInput): Promise<{ fcEndpoint: string }> {
  const env: Record<string, string> = { PORT: "9000", NODE_ENV: "production" };

  if (needsDatabase(input.appType)) {
    if (!deps.adminExec || !deps.appsBaseUrl) {
      throw new Error("apps database is not configured (APPS_DB_ADMIN_URL)");
    }
    // ensureAppSchema rotates the role password on every call, so the
    // connection string it returns is only valid if we write it into the
    // function env in the same breath — which is what ensureFunction does.
    const password = (deps.genPassword ?? (() => randomBytes(18).toString("base64url")))();
    const conn = await ensureAppSchema(deps.adminExec, {
      appId: input.appId, slug: input.slug, password, baseUrl: deps.appsBaseUrl,
    });
    env.DATABASE_URL = conn.connectionString;
  }

  await deps.fcOps.ensureFunction(input.fcFunctionName, {
    ossObjectName: input.ossObjectName,
    env,
  });
  const fcEndpoint = await deps.fcOps.ensureHttpTrigger(input.fcFunctionName);
  return { fcEndpoint };
}

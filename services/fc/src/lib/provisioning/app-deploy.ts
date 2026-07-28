import { randomBytes } from "node:crypto";
import { ensureAppSchema } from "./app-postgres.js";

export function appFunctionName(appId: string): string { return `tc-app-${appId}`; }
export function appOssObjectName(appId: string): string { return `apps/${appId}/code.zip`; }

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
  adminExec: (sql: string) => Promise<void>;
  fcOps: {
    ensureFunction: (name: string, a: { ossObjectName: string; env: Record<string, string> }) => Promise<void>;
    ensureHttpTrigger: (name: string) => Promise<string>;
  };
  appsBaseUrl: string;
  genPassword?: () => string;
}
export interface FinalizeInput { appId: string; slug: string; fcFunctionName: string; ossObjectName: string; }

export async function finalizeDeploy(deps: FinalizeDeps, input: FinalizeInput): Promise<{ fcEndpoint: string }> {
  // ensureAppSchema rotates the role password on every call, so the connection
  // string it returns is only valid if we write it into the function env in the
  // same breath — which is exactly what ensureFunction does below.
  const password = (deps.genPassword ?? (() => randomBytes(18).toString("base64url")))();
  const conn = await ensureAppSchema(deps.adminExec, {
    appId: input.appId, slug: input.slug, password, baseUrl: deps.appsBaseUrl,
  });
  await deps.fcOps.ensureFunction(input.fcFunctionName, {
    ossObjectName: input.ossObjectName,
    env: { PORT: "9000", NODE_ENV: "production", DATABASE_URL: conn.connectionString },
  });
  const fcEndpoint = await deps.fcOps.ensureHttpTrigger(input.fcFunctionName);
  return { fcEndpoint };
}

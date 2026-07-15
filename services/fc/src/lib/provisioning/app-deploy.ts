import { randomBytes } from "node:crypto";
import { ensureAppSchema } from "./app-postgres.js";

export interface DeployDeps {
  adminExec: (sql: string) => Promise<void>;
  fcOps: {
    ensureFunction: (name: string, a: { ossObjectName: string; env: Record<string, string> }) => Promise<void>;
    ensureHttpTrigger: (name: string) => Promise<string>;
    updateFunctionCode: (name: string, a: { ossObjectName: string; env: Record<string, string> }) => Promise<void>;
  };
  bucket: string;
  appsBaseUrl: string;
  genPassword?: () => string;
  mintUploadUrl: (ossObjectName: string) => Promise<string>;
}

export interface StartDeployInput { appId: string; slug: string; region: string; }
export interface StartDeployResult {
  fcFunctionName: string; fcRegion: string; ossObjectName: string; databaseUrl: string;
  presignedPut: string;
}

export function appFunctionName(appId: string): string { return `tc-app-${appId}`; }
export function appOssObjectName(appId: string): string { return `apps/${appId}/code.zip`; }

// --- Finalize: point the function at the now-uploaded code object + ensure
// the HTTP trigger, then surface the public endpoint. Uses a CODE-ONLY update
// so the function env (incl. the secret DATABASE_URL set at startDeploy) is
// preserved — we no longer hold it here.
// [LIVE-GATE: M4-T12]
//   (a) startDeploy's createFunction references a code object that does not yet
//       exist (the daemon uploads code.zip after); confirm FC tolerates this
//       ordering (create-then-upload) or adjust to create-on-finalize.
//   (b) code-only updateFunction here preserves existing environmentVariables;
//       confirm live so DATABASE_URL is not wiped.
export interface FinalizeDeps {
  fcOps: {
    updateFunctionCodeOnly: (name: string, ossObjectName: string) => Promise<void>;
    ensureHttpTrigger: (name: string) => Promise<string>;
  };
}
export interface FinalizeInput { fcFunctionName: string; ossObjectName: string; }
export async function finalizeDeploy(deps: FinalizeDeps, input: FinalizeInput): Promise<{ fcEndpoint: string }> {
  await deps.fcOps.updateFunctionCodeOnly(input.fcFunctionName, input.ossObjectName);
  const fcEndpoint = await deps.fcOps.ensureHttpTrigger(input.fcFunctionName);
  return { fcEndpoint };
}

export async function startDeploy(deps: DeployDeps, input: StartDeployInput): Promise<StartDeployResult> {
  const password = (deps.genPassword ?? (() => randomBytes(18).toString("base64url")))();
  const conn = await ensureAppSchema(deps.adminExec, {
    appId: input.appId, slug: input.slug, password, baseUrl: deps.appsBaseUrl,
  });
  const functionName = appFunctionName(input.appId);
  const ossObjectName = appOssObjectName(input.appId);
  await deps.fcOps.ensureFunction(functionName, {
    ossObjectName,
    env: { PORT: "9000", NODE_ENV: "production", DATABASE_URL: conn.connectionString },
  });
  const presignedPut = await deps.mintUploadUrl(ossObjectName);
  return { fcFunctionName: functionName, fcRegion: input.region, ossObjectName, databaseUrl: conn.connectionString, presignedPut };
}

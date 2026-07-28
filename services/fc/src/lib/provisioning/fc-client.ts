import FcClient, * as $fc from "@alicloud/fc20230330";
import { Config } from "@alicloud/openapi-client";

type FcClientInstance = InstanceType<typeof FcClient.default>;

const REGION = () => process.env.REGION || "cn-hangzhou";

/** Pull the account id out of a RAM role ARN: `acs:ram::<accountId>:role/<name>`. */
export function accountIdFromRoleArn(arn: string | undefined): string | null {
  const m = /^acs:ram::(\d+):/.exec((arn ?? "").trim());
  return m ? m[1] : null;
}

/**
 * FC 3.0 data-plane host, which is ACCOUNT-scoped:
 * `<accountId>.<region>.fc.aliyuncs.com`. The OSS `ENDPOINT` env (oss.ts) is a
 * different host and is NOT reusable.
 *
 * Resolution order: an explicit `FC_ENDPOINT`, then `ALIYUN_ACCOUNT_ID`, then
 * the account id embedded in `ROLE_ARN` — which every deployment that can talk
 * to OSS already has, so app deploys need no new configuration at all.
 */
export function resolveFcEndpoint(): string | null {
  const explicit = process.env.FC_ENDPOINT?.trim();
  if (explicit) return explicit;
  const accountId =
    process.env.ALIYUN_ACCOUNT_ID?.trim() || accountIdFromRoleArn(process.env.ROLE_ARN);
  return accountId ? `${accountId}.${REGION()}.fc.aliyuncs.com` : null;
}

export function fcEndpoint(): string {
  const endpoint = resolveFcEndpoint();
  // Without any of them the composed host used to come out as the literal
  // "undefined.<region>.fc.aliyuncs.com" and every call failed with a DNS
  // error that named no variable at all. Fail with the config problem instead.
  if (!endpoint) {
    throw new Error(
      "FC endpoint is not configured: set FC_ENDPOINT, ALIYUN_ACCOUNT_ID, or a ROLE_ARN to derive it from",
    );
  }
  return endpoint;
}

export function getFcClient(): FcClientInstance {
  const endpoint = fcEndpoint();
  return new FcClient.default(new Config({
    accessKeyId: process.env.ACCESS_KEY_ID,
    accessKeySecret: process.env.ACCESS_KEY_SECRET,
    regionId: REGION(),
    endpoint,
  }) as any);
}

export interface FcOpsConfig { bucket: string; role: string | undefined; }
export interface EnsureFunctionArgs { ossObjectName: string; env: Record<string, string>; }

function isNotFound(e: any): boolean {
  return e?.statusCode === 404 || e?.code === "FunctionNotFound" || e?.data?.Code === "FunctionNotFound";
}
function isAlreadyExists(e: any): boolean {
  return e?.statusCode === 409 || /AlreadyExists/i.test(e?.code ?? e?.data?.Code ?? "");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeFcOps(client: any, cfg: FcOpsConfig) {
  function codeLocation(ossObjectName: string) {
    return new $fc.InputCodeLocation({ ossBucketName: cfg.bucket, ossObjectName });
  }
  return {
    async ensureFunction(functionName: string, args: EnsureFunctionArgs): Promise<void> {
      let exists = true;
      try { await client.getFunction(functionName, new $fc.GetFunctionRequest({})); }
      catch (e) { if (isNotFound(e)) exists = false; else throw e; }
      if (!exists) {
        await client.createFunction(new $fc.CreateFunctionRequest({
          body: new $fc.CreateFunctionInput({
            functionName,
            runtime: "custom.debian10",
            handler: "index.handler",
            memorySize: 512, cpu: 0.5, timeout: 60, diskSize: 512,
            role: cfg.role,
            environmentVariables: args.env,
            customRuntimeConfig: new $fc.CustomRuntimeConfig({
              // The daemon zips the CONTENTS of the build's `.output` directory
              // (app_build.rs `zip_dir(workdir.join(".output"))`), so the server
              // entry sits at `server/index.mjs` inside the artifact — a
              // `.output/` prefix here points at a path that is never unpacked
              // and the function never boots.
              command: ["node"], args: ["server/index.mjs"], port: 9000,
            }),
            code: codeLocation(args.ossObjectName),
          }),
        }));
      } else {
        await this.updateFunctionCode(functionName, args);
      }
    },
    async updateFunctionCode(functionName: string, args: EnsureFunctionArgs): Promise<void> {
      await client.updateFunction(functionName, new $fc.UpdateFunctionRequest({
        body: new $fc.UpdateFunctionInput({
          environmentVariables: args.env,
          code: codeLocation(args.ossObjectName),
        }),
      }));
    },
    async ensureHttpTrigger(functionName: string): Promise<string> {
      try {
        await client.createTrigger(functionName, new $fc.CreateTriggerRequest({
          body: new $fc.CreateTriggerInput({
            triggerName: "http", triggerType: "http",
            triggerConfig: JSON.stringify({ authType: "anonymous", methods: ["GET", "POST", "PUT", "DELETE"] }),
          }),
        }));
      } catch (e) { if (!isAlreadyExists(e)) throw e; }
      const t = await client.getTrigger(functionName, "http");
      const url = t?.body?.httpTrigger?.urlInternet;
      if (!url) throw new Error("http trigger has no urlInternet");
      return url;
    },
  };
}

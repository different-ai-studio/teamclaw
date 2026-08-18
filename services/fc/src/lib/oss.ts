import { S3Client } from "@aws-sdk/client-s3";

// ---------------------------------------------------------------------------
// OSS / S3-compatible environment helpers
//
// Each reader takes the environment as an argument (defaulting to process.env)
// so the apps profile in provisioning/apps-oss.ts can resolve its fallbacks
// against an injected environment without duplicating these defaults — a
// duplicated default is how a bucket name drifts between two code paths.
// ---------------------------------------------------------------------------
type Env = NodeJS.ProcessEnv;

export const ACCESS_KEY_ID = (env: Env = process.env) => env.ACCESS_KEY_ID;
export const ACCESS_KEY_SECRET = (env: Env = process.env) => env.ACCESS_KEY_SECRET;
export const OSS_BUCKET = (env: Env = process.env) => env.BUCKET || "teamclu-sync";
export const OSS_REGION = (env: Env = process.env) => env.REGION || "cn-hangzhou";
export const OSS_ENDPOINT = (env: Env = process.env) =>
  env.ENDPOINT || "https://oss-cn-hangzhou.aliyuncs.com";
export const OSS_FORCE_PATH_STYLE = (env: Env = process.env) => {
  const raw = env.S3_FORCE_PATH_STYLE;
  return raw === "1" || raw === "true";
};

export function getS3Client(): S3Client {
  return new S3Client({
    region: OSS_REGION(),
    endpoint: OSS_ENDPOINT(),
    credentials: {
      accessKeyId: ACCESS_KEY_ID()!,
      secretAccessKey: ACCESS_KEY_SECRET()!,
    },
    forcePathStyle: OSS_FORCE_PATH_STYLE(),
  });
}

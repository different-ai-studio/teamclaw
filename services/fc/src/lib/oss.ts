import { S3Client } from "@aws-sdk/client-s3";

// ---------------------------------------------------------------------------
// OSS / S3-compatible environment helpers
// ---------------------------------------------------------------------------
export const ACCESS_KEY_ID = () => process.env.ACCESS_KEY_ID;
export const ACCESS_KEY_SECRET = () => process.env.ACCESS_KEY_SECRET;
export const OSS_BUCKET = () => process.env.BUCKET || "teamclaw-sync";
export const OSS_REGION = () => process.env.REGION || "cn-hangzhou";
export const OSS_ENDPOINT = () =>
  process.env.ENDPOINT || "https://oss-cn-hangzhou.aliyuncs.com";
export const OSS_FORCE_PATH_STYLE = () => {
  const raw = process.env.S3_FORCE_PATH_STYLE;
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

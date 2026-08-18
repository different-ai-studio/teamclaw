import { S3Client } from "@aws-sdk/client-s3";
import {
  ACCESS_KEY_ID,
  ACCESS_KEY_SECRET,
  OSS_BUCKET,
  OSS_ENDPOINT,
  OSS_FORCE_PATH_STYLE,
  OSS_REGION,
} from "../oss.js";

/**
 * Where an app's built code artifact (`apps/<appId>/code.zip`) is staged, and
 * with which credentials — for BOTH the presigned upload the daemon PUTs to
 * and the OSS object Function Compute reads the code from.
 *
 * Why this is not simply the deployment's default S3 config: on self-host the
 * default one is MinIO (`ACCESS_KEY_ID`/`ACCESS_KEY_SECRET` are the MinIO root
 * credentials, `ENDPOINT` is `https://s3.<host>`, `S3_FORCE_PATH_STYLE=1`).
 * Alibaba Function Compute cannot read code out of a box-local MinIO bucket, so
 * a self-host deployment that wants app deploys needs a SECOND, real Alibaba
 * OSS profile alongside the MinIO one. On the Alibaba FC target both are the
 * same account and no new configuration is needed at all.
 */
export interface AppsOssProfile {
  bucket: string;
  region: string;
  endpoint: string;
  accessKeyId: string;
  accessKeySecret: string;
  /** Only MinIO needs path-style addressing; Alibaba OSS is virtual-host. */
  forcePathStyle: boolean;
}

export type AppsOssResolution =
  | { profile: AppsOssProfile; error?: undefined }
  | { profile?: undefined; error: string };

type Env = NodeJS.ProcessEnv;

const trimmed = (v: string | undefined) => v?.trim() || "";

/**
 * Region for the app's function AND its code bucket. Function Compute can only
 * load code from an OSS bucket in its OWN region, so one knob covers both — two
 * would let them drift into a deploy that fails inside the FC API.
 */
export function appsRegion(env: Env = process.env): string {
  return trimmed(env.APPS_REGION) || OSS_REGION(env);
}

/**
 * Resolve the apps artifact profile, or explain what is missing.
 *
 * Returning the reason rather than a bare null is deliberate: the failure this
 * replaces surfaced to the user as `deploy provisioning not configured`, which
 * named no variable and cost an SSH session to diagnose.
 */
export function resolveAppsOss(env: Env = process.env): AppsOssResolution {
  const dedicatedKey = trimmed(env.APPS_ACCESS_KEY_ID);

  // --- Dedicated profile: apps live in a different account than the default
  // S3 config (the self-host shape). Nothing is inherited from ENDPOINT /
  // S3_FORCE_PATH_STYLE — inheriting them is precisely how app code would get
  // presigned into MinIO with an Alibaba key and 403 on upload.
  if (dedicatedKey) {
    const secret = trimmed(env.APPS_ACCESS_KEY_SECRET);
    if (!secret) {
      return { error: "APPS_ACCESS_KEY_ID is set but APPS_ACCESS_KEY_SECRET is empty" };
    }
    const bucket = trimmed(env.APPS_OSS_BUCKET);
    if (!bucket) {
      return {
        error:
          "APPS_ACCESS_KEY_ID is set but APPS_OSS_BUCKET is empty — app code cannot fall back to BUCKET, which belongs to the default (possibly MinIO) endpoint",
      };
    }
    const region = appsRegion(env);
    return {
      profile: {
        bucket,
        region,
        endpoint: trimmed(env.APPS_OSS_ENDPOINT) || `https://oss-${region}.aliyuncs.com`,
        accessKeyId: dedicatedKey,
        accessKeySecret: secret,
        forcePathStyle: false,
      },
    };
  }

  // --- Shared profile: one account for everything (the Alibaba FC target).
  const accessKeyId = ACCESS_KEY_ID(env);
  const accessKeySecret = ACCESS_KEY_SECRET(env);
  if (!accessKeyId || !accessKeySecret) {
    return { error: "ACCESS_KEY_ID / ACCESS_KEY_SECRET are not set" };
  }
  // A bucket override alone is fine (same account, separate bucket for app
  // code); a REGION override alone is not, because ENDPOINT still points at the
  // old region and FC would be handed a cross-region code location.
  if (trimmed(env.APPS_REGION) && trimmed(env.APPS_REGION) !== OSS_REGION(env)) {
    return {
      error:
        `APPS_REGION (${trimmed(env.APPS_REGION)}) differs from REGION (${OSS_REGION(env)}) without a dedicated apps profile — also set APPS_ACCESS_KEY_ID / APPS_ACCESS_KEY_SECRET / APPS_OSS_BUCKET`,
    };
  }
  return {
    profile: {
      bucket: trimmed(env.APPS_OSS_BUCKET) || OSS_BUCKET(env),
      region: OSS_REGION(env),
      endpoint: OSS_ENDPOINT(env),
      accessKeyId,
      accessKeySecret,
      forcePathStyle: OSS_FORCE_PATH_STYLE(env),
    },
  };
}

/** S3 client for the app-artifact bucket — never the default team-blobs one. */
export function getAppsS3Client(profile: AppsOssProfile): S3Client {
  return new S3Client({
    region: profile.region,
    endpoint: profile.endpoint,
    credentials: {
      accessKeyId: profile.accessKeyId,
      secretAccessKey: profile.accessKeySecret,
    },
    forcePathStyle: profile.forcePathStyle,
  });
}

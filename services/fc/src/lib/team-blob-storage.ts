import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createServiceRoleClient } from "./supabase.js";
import { getS3Client } from "./oss.js";

// ---------------------------------------------------------------------------
// Blob storage for team files.
//
// Both team sync (knowledge documents) and the skills registry store immutable,
// content-addressed, client-encrypted blobs. They share this signing layer and
// differ only in which private bucket they land in — one place to change when
// the storage backend moves again.
//
// Two backends, picked by `TEAM_BLOBS_BACKEND`:
//
//   supabase (default) — Supabase Storage, the historical home.
//   s3                 — any S3-compatible store: MinIO on self-host, Alibaba
//                        OSS on the Aliyun FC target. Same protocol both ways,
//                        which is the point: file bytes stop riding on the
//                        Postgres-adjacent stack that also serves auth and the
//                        control plane.
//
// The switch is an explicit env var rather than "S3 creds are present": the
// Aliyun target already sets `ACCESS_KEY_ID` for app-bundle uploads, and
// inferring from that would silently relocate every team's blobs the day
// someone configured app deploys.
//
// Object paths keep the historical `teams/<teamId>/blobs/sha256/<aa>/<bb>/<hash>`
// shape, and `amuxc_blobs.oss_key` keeps its name: the column is just "where the
// bytes are", and renaming it would be a large migration for zero behaviour.
// ---------------------------------------------------------------------------

/**
 * Signed URLs are minted with the service-role client, which talks to Supabase
 * over `SUPABASE_URL`. On self-host that is the in-cluster address
 * (`http://kong:8000`) — correct for FC, useless to the client the URL is
 * handed to, which cannot resolve `kong` and fails the transfer outright.
 *
 * So rewrite the origin to the publicly reachable one. The path, query and
 * token are untouched; only the host the client dials changes.
 */
function toPublicUrl(signedUrl: string): string {
  const publicBase = process.env.SUPABASE_PUBLIC_URL?.trim();
  if (!publicBase) return signedUrl;
  try {
    const target = new URL(signedUrl, process.env.SUPABASE_URL || undefined);
    const base = new URL(publicBase);
    target.protocol = base.protocol;
    // hostname + port, not `host`: the `host` setter leaves the existing port
    // in place when the value it is given has none, so kong's :8000 survived
    // onto the public hostname and the transfer still failed.
    target.hostname = base.hostname;
    target.port = base.port;
    return target.toString();
  } catch {
    return signedUrl;
  }
}

/** What sync-handlers and the skills routes need from a blob store. */
export interface BlobStorage {
  createUploadUrl(objectPath: string): Promise<string>;
  createDownloadUrl(objectPath: string, expiresIn?: number): Promise<string>;
  /** `null` when the object does not exist. */
  stat(objectPath: string): Promise<{ size: number } | null>;
}

export const TEAM_BLOBS_BUCKET = () => process.env.TEAM_BLOBS_STORAGE_BUCKET || "team-blobs";
export const SKILLS_BUCKET = () => process.env.SKILLS_STORAGE_BUCKET || "team-skills";

function splitPath(objectPath: string): { dir: string; name: string } {
  const slash = objectPath.lastIndexOf("/");
  return { dir: objectPath.slice(0, slash), name: objectPath.slice(slash + 1) };
}

/** A `BlobStorage` backed by one private Supabase Storage bucket. */
export function supabaseBlobStorage(bucket: () => string): BlobStorage {
  return {
    async createUploadUrl(objectPath) {
      const { data, error } = await createServiceRoleClient()
        .storage.from(bucket())
        .createSignedUploadUrl(objectPath, { upsert: true });
      if (error || !data) {
        throw new Error(
          `failed to create signed upload url: ${error?.message ?? "unknown error"}`,
        );
      }
      return toPublicUrl(data.signedUrl);
    },

    async createDownloadUrl(objectPath, expiresIn = 900) {
      const { data, error } = await createServiceRoleClient()
        .storage.from(bucket())
        .createSignedUrl(objectPath, expiresIn);
      if (error || !data) {
        throw new Error(
          `failed to create signed download url: ${error?.message ?? "unknown error"}`,
        );
      }
      return toPublicUrl(data.signedUrl);
    },

    async stat(objectPath) {
      // Supabase Storage has no HEAD; `list` scoped to the parent directory with
      // a `search` on the exact filename is the cheapest equivalent.
      const { dir, name } = splitPath(objectPath);
      const { data, error } = await createServiceRoleClient()
        .storage.from(bucket())
        .list(dir, { search: name, limit: 1 });
      if (error || !data) return null;
      const entry = data.find((f: { name: string }) => f.name === name);
      if (!entry) return null;
      return { size: (entry as { metadata?: { size?: number } }).metadata?.size ?? 0 };
    },
  };
}

/**
 * A `BlobStorage` backed by one private S3-compatible bucket.
 *
 * Presigned URLs are handed to the daemon, which PUTs/GETs them **directly** —
 * FC never sees the bytes. So `ENDPOINT` must be the host the client can reach,
 * not an in-cluster address: SigV4 covers the Host header, so signing for
 * `minio:9000` and dialing `s3.example.com` fails the signature, and signing
 * for a host the client cannot resolve fails the transfer. This is why the
 * self-host MinIO sits behind Caddy on its own domain.
 */
export function s3BlobStorage(bucket: () => string): BlobStorage {
  return {
    async createUploadUrl(objectPath) {
      // `as any`: two @aws-sdk major versions coexist in the tree, so the
      // presigner's `Client` and this `S3Client` have separate declarations of
      // a private field. Same cast `index.ts` uses for app-bundle uploads.
      return getSignedUrl(
        getS3Client() as any,
        new PutObjectCommand({ Bucket: bucket(), Key: objectPath }),
        { expiresIn: 900 },
      );
    },

    async createDownloadUrl(objectPath, expiresIn = 900) {
      return getSignedUrl(
        getS3Client() as any,
        new GetObjectCommand({ Bucket: bucket(), Key: objectPath }),
        { expiresIn },
      );
    },

    async stat(objectPath) {
      try {
        const head = await getS3Client().send(
          new HeadObjectCommand({ Bucket: bucket(), Key: objectPath }),
        );
        return { size: head.ContentLength ?? 0 };
      } catch (e) {
        if (isMissingObject(e)) return null;
        throw e;
      }
    },
  };
}

/**
 * Whether an S3 error means "no such object" rather than a real failure.
 *
 * A missing object is the normal needs-upload answer. Everything else (bad
 * creds, network, bucket gone) must propagate: treating those as "absent" would
 * report every blob as missing and re-upload the entire team.
 */
export function isMissingObject(e: unknown): boolean {
  const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  const name = (e as { name?: string })?.name;
  return status === 404 || name === "NotFound" || name === "NoSuchKey";
}

/** Which backend `getTeamBlobStorage` / the skills store resolve to. */
export function blobBackendKind(): "s3" | "supabase" {
  return process.env.TEAM_BLOBS_BACKEND?.trim() === "s3" ? "s3" : "supabase";
}

/** A blob store for `bucket`, on whichever backend this deployment runs. */
export function blobStorageFor(bucket: () => string): BlobStorage {
  return blobBackendKind() === "s3" ? s3BlobStorage(bucket) : supabaseBlobStorage(bucket);
}

let cachedTeamBlobStorage: BlobStorage | undefined;

/** Default blob store for team file sync. */
export function getTeamBlobStorage(): BlobStorage {
  cachedTeamBlobStorage ??= blobStorageFor(TEAM_BLOBS_BUCKET);
  return cachedTeamBlobStorage;
}

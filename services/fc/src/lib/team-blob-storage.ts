import { createServiceRoleClient } from "./supabase.js";

// ---------------------------------------------------------------------------
// Supabase Storage helpers for team blobs.
//
// Both team sync (knowledge documents) and the skills registry store immutable,
// content-addressed, client-encrypted blobs. They share this signing layer and
// differ only in which private bucket they land in — one place to change when
// the storage backend moves again.
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

let cachedTeamBlobStorage: BlobStorage | undefined;

/** Default blob store for team file sync. */
export function getTeamBlobStorage(): BlobStorage {
  cachedTeamBlobStorage ??= supabaseBlobStorage(TEAM_BLOBS_BUCKET);
  return cachedTeamBlobStorage;
}

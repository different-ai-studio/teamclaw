import { createServiceRoleClient } from "./supabase.js";

// ---------------------------------------------------------------------------
// Supabase Storage helpers for team skill package blobs.
//
// Package bodies (zips) live in a private Supabase Storage bucket, keyed by
// the same content-addressed path amuxc_blobs already tracks
// (teams/<teamId>/blobs/sha256/<aa>/<bb>/<hash>). amuxc_blobs stays the
// dedup/bookkeeping table; oss_key just holds this bucket's object path now.
// ---------------------------------------------------------------------------

const DEFAULT_BUCKET = "team-skills";

export const SKILLS_BUCKET = () => process.env.SKILLS_STORAGE_BUCKET || DEFAULT_BUCKET;

function splitPath(objectPath: string): { dir: string; name: string } {
  const slash = objectPath.lastIndexOf("/");
  return { dir: objectPath.slice(0, slash), name: objectPath.slice(slash + 1) };
}

export async function createSkillUploadUrl(objectPath: string): Promise<string> {
  const { data, error } = await createServiceRoleClient()
    .storage.from(SKILLS_BUCKET())
    .createSignedUploadUrl(objectPath, { upsert: true });
  if (error || !data) {
    throw new Error(`failed to create signed upload url: ${error?.message ?? "unknown error"}`);
  }
  return data.signedUrl;
}

export async function statSkillObject(objectPath: string): Promise<{ size: number } | null> {
  const { dir, name } = splitPath(objectPath);
  const { data, error } = await createServiceRoleClient()
    .storage.from(SKILLS_BUCKET())
    .list(dir, { search: name, limit: 1 });
  if (error || !data) return null;
  const entry = data.find((f: any) => f.name === name);
  if (!entry) return null;
  return { size: entry.metadata?.size ?? 0 };
}

export async function createSkillDownloadUrl(
  objectPath: string,
  expiresIn = 900,
): Promise<string> {
  const { data, error } = await createServiceRoleClient()
    .storage.from(SKILLS_BUCKET())
    .createSignedUrl(objectPath, expiresIn);
  if (error || !data) {
    throw new Error(`failed to create signed download url: ${error?.message ?? "unknown error"}`);
  }
  return data.signedUrl;
}

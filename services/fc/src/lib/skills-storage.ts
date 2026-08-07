import { SKILLS_BUCKET, supabaseBlobStorage } from "./team-blob-storage.js";

// ---------------------------------------------------------------------------
// Supabase Storage helpers for team skill package blobs.
//
// Package bodies (zips) live in a private Supabase Storage bucket, keyed by the
// same content-addressed path amuxc_blobs already tracks
// (teams/<teamId>/blobs/sha256/<aa>/<bb>/<hash>). amuxc_blobs stays the
// dedup/bookkeeping table; oss_key just holds this bucket's object path now.
//
// The signing itself lives in team-blob-storage.ts, shared with team file sync;
// this module is the skills-bucket binding plus the names its callers use.
// ---------------------------------------------------------------------------

export { SKILLS_BUCKET };

const storage = supabaseBlobStorage(SKILLS_BUCKET);

export function createSkillUploadUrl(objectPath: string): Promise<string> {
  return storage.createUploadUrl(objectPath);
}

export function statSkillObject(objectPath: string): Promise<{ size: number } | null> {
  return storage.stat(objectPath);
}

export function createSkillDownloadUrl(
  objectPath: string,
  expiresIn = 900,
): Promise<string> {
  return storage.createDownloadUrl(objectPath, expiresIn);
}

export type { CacheDb } from "./local-cache";

import type { CacheDb } from "./local-cache";

/**
 * The app's SQLite handle, narrowed to what the cache layer uses.
 *
 * Loaded through a dynamic import so that importing a cache module does not
 * pull `expo-sqlite` — and through it React Native — into the module graph.
 * Vitest cannot parse React Native's Flow sources, so a static import here
 * would make every cache consumer untestable, which is the same constraint
 * that keeps the pure logic modules free of RN imports.
 */
export async function openCacheDb(): Promise<CacheDb> {
  const { getDb } = await import("./sqlite");
  return (await getDb()) as unknown as CacheDb;
}

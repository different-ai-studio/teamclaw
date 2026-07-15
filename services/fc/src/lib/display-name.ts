// Default member display-name generator.
//
// New / anonymous owners used to land as "You" (Supabase) or the team name
// (Postgres) — both read poorly to teammates in shared contexts. Clients now
// pass a real name (OS full name / email prefix); when absent we synthesize a
// stable, non-throwaway-looking "Adjective Animal" handle.
//
// Wordlists mirror apps/ios/.../Onboarding/RandomTeamName.swift and the SQL
// arrays in services/supabase/migrations/20260604000000_create_team_display_name.sql
// — keep all three in sync if edited.

export const DISPLAY_NAME_ADJECTIVES = [
  "Curious", "Brave", "Calm", "Eager", "Lively", "Mellow", "Nimble", "Quick",
  "Quiet", "Sunny", "Witty", "Zesty", "Bright", "Daring", "Gentle", "Jolly",
  "Keen", "Plucky", "Spry", "Sparkling",
] as const;

export const DISPLAY_NAME_ANIMALS = [
  "Otter", "Panda", "Falcon", "Fox", "Heron", "Lynx", "Owl", "Puffin", "Quokka",
  "Raven", "Seal", "Tapir", "Viper", "Walrus", "Yak", "Zebra", "Badger", "Cougar",
  "Dolphin", "Hare",
] as const;

// FNV-1a 32-bit. We only need stable, well-distributed indices from a seed
// string (the actor id) — not cryptographic strength.
function hashSeed(seed: string, salt: number): number {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Generate a default "Adjective Animal" display name.
 *
 * With a `seed` (the actor id) the result is deterministic and stable across
 * reads; without one it is random. Pass the seed whenever possible so the name
 * never changes underneath the user.
 */
export function generateDisplayName(seed?: string | null): string {
  if (seed && seed.length > 0) {
    const adj = DISPLAY_NAME_ADJECTIVES[hashSeed(seed, 11) % DISPLAY_NAME_ADJECTIVES.length];
    const animal = DISPLAY_NAME_ANIMALS[hashSeed(seed, 29) % DISPLAY_NAME_ANIMALS.length];
    return `${adj} ${animal}`;
  }
  const adj = DISPLAY_NAME_ADJECTIVES[Math.floor(Math.random() * DISPLAY_NAME_ADJECTIVES.length)];
  const animal = DISPLAY_NAME_ANIMALS[Math.floor(Math.random() * DISPLAY_NAME_ANIMALS.length)];
  return `${adj} ${animal}`;
}

/**
 * Humanized random team name for the auto-onboarding path when a freshly
 * signed-up user has no team invites. Mirrors iOS RandomTeamName so the
 * names feel consistent across platforms.
 */

const ADJECTIVES = [
  "Curious", "Brave", "Calm", "Eager", "Lively", "Mellow", "Nimble",
  "Quick", "Quiet", "Sunny", "Witty", "Zesty", "Bright", "Daring",
  "Gentle", "Jolly", "Keen", "Plucky", "Spry", "Sparkling",
] as const;

const ANIMALS = [
  "Otter", "Panda", "Falcon", "Fox", "Heron", "Lynx", "Owl", "Puffin",
  "Quokka", "Raven", "Seal", "Tapir", "Viper", "Walrus", "Yak", "Zebra",
  "Badger", "Cougar", "Dolphin", "Hare",
] as const;

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] ?? arr[0];
}

export function generateRandomTeamName(): string {
  return `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
}

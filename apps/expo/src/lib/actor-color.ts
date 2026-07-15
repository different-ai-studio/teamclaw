const PALETTE: ReadonlyArray<{ bg: string; fg: string }> = [
  { bg: "#e85a4a", fg: "#fff" },
  { bg: "#7a6cf5", fg: "#fff" },
  { bg: "#3a8f63", fg: "#fff" },
  { bg: "#c98a3c", fg: "#fff" },
  { bg: "#3a6dbf", fg: "#fff" },
  { bg: "#a5527c", fg: "#fff" },
  { bg: "#1f8b94", fg: "#fff" },
  { bg: "#6a7a3a", fg: "#fff" },
  { bg: "#b56042", fg: "#fff" },
  { bg: "#5a6a7a", fg: "#fff" },
];

function hashString(input: string): number {
  let hash = 5381;

  for (const char of input) {
    hash = ((hash << 5) + hash + char.charCodeAt(0)) | 0;
  }

  return Math.abs(hash);
}

// Keep this palette logic in sync with packages/app/src/lib/actor-color.ts.
export function actorAvatarColor(key: string | null | undefined): { bg: string; fg: string } {
  if (!key) {
    return PALETTE[PALETTE.length - 1];
  }

  return PALETTE[hashString(key) % PALETTE.length];
}

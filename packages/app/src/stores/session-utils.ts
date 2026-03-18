/**
 * Compare workspace paths, handling ~/path vs /absolute/path in web mode.
 * In web mode, workspacePath may be ~/opencode-test (not expanded) while
 * OpenCode returns event.directory as /Users/xxx/opencode-test.
 */
export function workspacePathsMatch(a: string, b: string): boolean {
  const na = a.replace(/\/+$/, "").replace(/\\/g, "/");
  const nb = b.replace(/\/+$/, "").replace(/\\/g, "/");
  if (na === nb) return true;
  // Handle ~/path vs /absolute/path when last component matches
  const partsA = na.split("/").filter(Boolean);
  const partsB = nb.split("/").filter(Boolean);
  const lastA = partsA[partsA.length - 1] ?? "";
  const lastB = partsB[partsB.length - 1] ?? "";
  if (lastA !== lastB) return false;
  const isTildeA = na.startsWith("~/");
  const isAbsoluteB = nb.startsWith("/");
  if (isTildeA && isAbsoluteB) return true;
  if (nb.startsWith("~/") && na.startsWith("/")) return true;
  return false;
}

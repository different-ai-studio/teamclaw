/**
 * Compile-time flag set when packaging the Chrome extension with
 * `INTERNAL=1` / `--internal` (see apps/extension/build.mjs).
 */
export function isInternalBuild(): boolean {
  const v = import.meta.env.VITE_INTERNAL
  return v === 'true' || v === '1'
}

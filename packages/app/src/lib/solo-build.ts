/**
 * Compile-time flag set when packaging the Chrome extension with
 * `SOLO=1` / `--solo` (see apps/extension/build.mjs).
 * Solo-agent build: hide permission control + model on mention pills.
 */
export function isSoloBuild(): boolean {
  const v = import.meta.env.VITE_SOLO
  return v === 'true' || v === '1'
}

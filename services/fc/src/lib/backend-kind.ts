/**
 * Resolves the active backend kind from environment variables.
 * Centralised here so other modules can import without creating a cycle
 * through src/index.ts.
 */
export function resolveBackendKind(
  env: NodeJS.ProcessEnv = process.env,
): "supabase" | "postgres" {
  return env.BACKEND_KIND === "postgres" ? "postgres" : "supabase";
}

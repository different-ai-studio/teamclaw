/**
 * agent-types — shared normalization for an agent's supported/default types.
 *
 * Invariant: `defaultAgentType` must always be a member of `supportedTypes`.
 * Otherwise the desktop/iOS actor detail shows the active type as absent from
 * "Supported types" (e.g. default=claude, supported=[opencode]). The daemon
 * normally sets default = first(supported), but stale data or a manual
 * `updateAgentDefaults` PATCH can drift them apart. Normalize on every write so
 * the invariant holds regardless of caller.
 */
export function normalizeAgentTypes(
  supportedTypes: string[] | null | undefined,
  defaultAgentType: string | null | undefined,
): { supportedTypes: string[]; defaultAgentType: string | null } {
  // Dedupe while preserving order; drop empties.
  const supported = Array.from(
    new Set((supportedTypes ?? []).filter((t): t is string => !!t)),
  );
  let def = defaultAgentType || null;

  if (def && !supported.includes(def)) {
    // Active type the daemon didn't list — keep it as a first-class supported
    // type rather than letting it look unsupported.
    supported.unshift(def);
  } else if (!def && supported.length > 0) {
    // No default given — fall back to the first supported type.
    def = supported[0];
  }

  return { supportedTypes: supported, defaultAgentType: def };
}

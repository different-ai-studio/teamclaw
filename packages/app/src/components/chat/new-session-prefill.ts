/**
 * Returns the set of actor ids to pre-select when the New Session dialog opens.
 * Pre-selects the effective default agent only when it is a real, selectable
 * candidate; otherwise selects nothing.
 */
export function computeInitialSelection(
  effectiveDefaultAgentId: string | null,
  candidateIds: ReadonlySet<string>,
): Set<string> {
  if (effectiveDefaultAgentId && candidateIds.has(effectiveDefaultAgentId)) {
    return new Set([effectiveDefaultAgentId])
  }
  return new Set()
}

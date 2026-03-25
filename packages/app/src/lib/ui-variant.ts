/**
 * Build-time UI shell preset via VITE_UI_VARIANT.
 * - unset, empty, or "default": classic layout
 * - "workspace": sidebar quick links + embedded settings sections layout
 */
export type UIVariant = 'default' | 'workspace'

const RAW = (import.meta.env.VITE_UI_VARIANT ?? '').trim().toLowerCase()

function normalizeUIVariant(raw: string): UIVariant {
  if (!raw || raw === 'default') return 'default'
  if (raw === 'workspace') return 'workspace'
  return 'default'
}

export const UI_VARIANT: UIVariant = normalizeUIVariant(RAW)

export function isDefaultUIVariant(): boolean {
  return UI_VARIANT === 'default'
}

export function isWorkspaceUIVariant(): boolean {
  return UI_VARIANT === 'workspace'
}

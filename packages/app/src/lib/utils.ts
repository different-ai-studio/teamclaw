import { clsx, type ClassValue } from "clsx"
import { toast } from 'sonner'
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function isTauri() {
  return (
    typeof window !== 'undefined' &&
    !!(window as unknown as { __TAURI__: unknown }).__TAURI__
  )
}

export async function copyToClipboard(text: string, successMessage?: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    if (successMessage) toast.success(successMessage)
  } catch {
    toast.error('Failed to copy')
  }
}

export async function openExternalUrl(url: string): Promise<void> {
  try {
    const { open } = await import("@tauri-apps/plugin-shell")
    await open(url)
  } catch {
    window.open(url, "_blank")
  }
}

/**
 * Shortens long paths or tokens for compact UI (e.g. "Always allow '…'").
 * Middle ellipsis keeps the start and end readable. Full value should be
 * shown via a title/tooltip when needed.
 */
export function truncatePermissionSnippet(text: string, maxLength = 40): string {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length <= maxLength) {
    return trimmed
  }
  const ellipsis = "…"
  const budget = maxLength - ellipsis.length
  if (budget < 4) {
    return `${trimmed.slice(0, Math.max(0, budget))}${ellipsis}`
  }
  const headChars = Math.ceil(budget / 2)
  const tailChars = Math.floor(budget / 2)
  return `${trimmed.slice(0, headChars)}${ellipsis}${trimmed.slice(-tailChars)}`
}

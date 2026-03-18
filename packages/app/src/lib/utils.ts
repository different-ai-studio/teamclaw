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

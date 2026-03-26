import { appShortName } from "@/lib/build-config"

export function getOnboardingStorageKey(id: string): string {
  return `${appShortName}-onboarding-${id}`
}

export function hasCompletedOnboarding(id: string): boolean {
  try {
    return localStorage.getItem(getOnboardingStorageKey(id)) === "done"
  } catch {
    return false
  }
}

export function markOnboardingCompleted(id: string): void {
  try {
    localStorage.setItem(getOnboardingStorageKey(id), "done")
  } catch {
    // ignore storage errors
  }
}

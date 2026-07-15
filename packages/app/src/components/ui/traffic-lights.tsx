import { isTauri } from "@/lib/utils"

/**
 * Spacer that reserves space for the native macOS traffic lights
 * when using titleBarStyle: "overlay".
 */
export function TrafficLights() {
  if (!isTauri()) {
    return null
  }

  return <div className="w-[68px] shrink-0 ml-[5px]" data-tauri-drag-region />
}

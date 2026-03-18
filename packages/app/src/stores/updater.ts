import { create } from "zustand"
import { isTauri } from "@/lib/utils"

export type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "up-to-date"
  | "downloading"
  | "ready"
  | "error"

export interface UpdateInfo {
  state: UpdateState
  version?: string
  notes?: string
  progress?: number
  errorMessage?: string
}

interface PendingUpdate {
  downloadUrl: string
  signature: string
}

interface UpdaterStore {
  update: UpdateInfo
  pendingUpdate: PendingUpdate | null
  setUpdate: (info: UpdateInfo) => void
  checkForUpdates: (silent?: boolean) => Promise<void>
  installUpdate: () => Promise<void>
  restart: () => Promise<void>
}

export const useUpdaterStore = create<UpdaterStore>((set, get) => ({
  update: { state: "idle" },
  pendingUpdate: null,

  setUpdate: (info) => set({ update: info }),

  checkForUpdates: async (silent = false) => {
    if (!isTauri()) {
      if (!silent) {
        set({ update: { state: "error", errorMessage: "Updates are only available in the desktop app." } })
      }
      return
    }

    set({ update: { state: "checking" } })

    try {
      const { invoke } = await import("@tauri-apps/api/core")
      const result = await invoke<{ version: string; notes: string; downloadUrl: string; signature: string } | null>("check_update")

      if (result) {
        set({
          update: {
            state: "available",
            version: result.version,
            notes: result.notes || "",
          },
          pendingUpdate: {
            downloadUrl: result.downloadUrl,
            signature: result.signature,
          },
        })
      } else {
        set({ update: { state: "up-to-date" }, pendingUpdate: null })
        // Auto-clear after 3s
        setTimeout(() => {
          const current = get().update
          if (current.state === "up-to-date") {
            set({ update: { state: "idle" } })
          }
        }, 3000)
      }
    } catch (err) {
      if (silent) {
        console.warn("[Updater] Check failed (silent):", err)
        set({ update: { state: "idle" } })
      } else {
        console.error("[Updater] Check failed:", err)
        set({ update: { state: "error", errorMessage: String(err) } })
      }
    }
  },

  installUpdate: async () => {
    const pending = get().pendingUpdate
    if (!pending) {
      set({ update: { state: "error", errorMessage: "No pending update to install." } })
      return
    }

    set({ update: { state: "downloading", progress: 0 } })

    try {
      const { invoke } = await import("@tauri-apps/api/core")
      const { listen } = await import("@tauri-apps/api/event")

      // Listen for download progress events from Rust
      const unlisten = await listen<{ downloaded: number; contentLength: number | null }>(
        "update-download-progress",
        (event) => {
          const { downloaded, contentLength } = event.payload
          if (contentLength && contentLength > 0) {
            set({
              update: {
                state: "downloading",
                progress: Math.round((downloaded / contentLength) * 100),
              },
            })
          }
        },
      )

      try {
        await invoke("download_and_install_update", {
          downloadUrl: pending.downloadUrl,
          signature: pending.signature,
        })
        set({ update: { state: "ready" }, pendingUpdate: null })
      } finally {
        unlisten()
      }
    } catch (err) {
      console.error("[Updater] Install failed:", err)
      set({ update: { state: "error", errorMessage: String(err) } })
    }
  },

  restart: async () => {
    try {
      const { relaunch } = await import("@tauri-apps/plugin-process")
      await relaunch()
    } catch (err) {
      console.error("[Updater] Relaunch failed:", err)
      set({
        update: {
          state: "error",
          errorMessage: "Failed to restart. Please restart manually.",
        },
      })
    }
  },
}))

/**
 * OpenCode preloader — deduplicates `start_opencode` invocations.
 *
 * On mount we fire `start_opencode` early so that by the time the main app
 * renders and requests it again for the same workspace, we simply return the
 * already-in-flight (or resolved) promise instead of spawning a second sidecar.
 */

export interface PreloadResult {
  url: string;
}

let current: {
  path: string;
  promise: Promise<PreloadResult>;
} | null = null;

/**
 * Start (or reuse) a `start_opencode` invocation for the given workspace.
 *
 * - If a request for the **same** path is already in flight, return the existing promise.
 * - If the path differs, start a brand-new request.
 * - On failure the entry is cleared so the next call retries.
 */
export function startOpenCode(workspacePath: string): Promise<PreloadResult> {
  if (current?.path === workspacePath) {
    return current.promise;
  }

  const promise = import("@tauri-apps/api/core")
    .then(({ invoke }) =>
      invoke<PreloadResult>("start_opencode", {
        config: { workspace_path: workspacePath },
      }),
    )
    .catch((err) => {
      // Clear on failure so a retry creates a fresh invocation
      if (current?.promise === promise) {
        current = null;
      }
      throw err;
    });

  current = { path: workspacePath, promise };
  return promise;
}

/** Check whether a preload is in-flight (or resolved) for the given path. */
export function hasPreloadFor(path: string): boolean {
  return current?.path === path;
}

/** Discard the current preload entry (e.g. on workspace change). */
export function clearPreload(): void {
  current = null;
}

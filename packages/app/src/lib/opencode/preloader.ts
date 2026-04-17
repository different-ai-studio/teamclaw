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
  bootstrapped: Promise<PreloadResult>;
  resolveBootstrapped: (result: PreloadResult) => void;
  bootstrappedResult: PreloadResult | null;
  cleanup: (() => void) | null;
} | null = null;

interface OpenCodeBootstrappedEvent extends PreloadResult {
  workspace_path: string;
}

function cleanupCurrentEntry(entry: typeof current): void {
  entry?.cleanup?.();
}

/**
 * Start (or reuse) a `start_opencode` invocation for the given workspace.
 *
 * - If a request for the **same** path is already in flight, return the existing promise.
 * - If the path differs, start a brand-new request.
 * - On failure the entry is cleared so the next call retries.
 *
 * `port` is optional: secondary windows opened via `create_workspace_window`
 * receive an explicit port via URL params and pass it here so each window's
 * sidecar lives on its own port.
 */
export function startOpenCode(workspacePath: string, port?: number): Promise<PreloadResult> {
  if (current?.path === workspacePath) {
    return current.promise;
  }

  cleanupCurrentEntry(current);

  let resolveBootstrapped!: (result: PreloadResult) => void;
  const bootstrapped = new Promise<PreloadResult>((resolve) => {
    resolveBootstrapped = resolve;
  });

  const entry = {
    path: workspacePath,
    promise: Promise.resolve({ url: "" }),
    bootstrapped,
    resolveBootstrapped,
    bootstrappedResult: null as PreloadResult | null,
    cleanup: null as (() => void) | null,
  };

  const promise = Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/event"),
  ])
    .then(async ([{ invoke }, { listen }]) => {
      entry.cleanup = await listen<OpenCodeBootstrappedEvent>(
        "opencode_bootstrapped",
        (event) => {
          if (event.payload.workspace_path !== workspacePath) return;
          const result = { url: event.payload.url };
          if (!entry.bootstrappedResult) {
            entry.bootstrappedResult = result;
            entry.resolveBootstrapped(result);
          }
        },
      );

      const config: { workspace_path: string; port?: number } = {
        workspace_path: workspacePath,
      };
      if (typeof port === "number") config.port = port;

      return invoke<PreloadResult>("start_opencode", { config });
    })
    .catch((err) => {
      // Clear on failure so a retry creates a fresh invocation
      if (current?.promise === promise) {
        cleanupCurrentEntry(current);
        current = null;
      }
      throw err;
    });

  entry.promise = promise;
  current = entry;
  return promise;
}

export function waitForOpenCodeBootstrapped(
  workspacePath: string,
  port?: number,
): Promise<PreloadResult> {
  if (current?.path !== workspacePath) {
    void startOpenCode(workspacePath, port);
  }

  if (!current || current.path !== workspacePath) {
    return Promise.reject(new Error("OpenCode preload was not initialized"));
  }

  return current.bootstrappedResult
    ? Promise.resolve(current.bootstrappedResult)
    : current.bootstrapped;
}

/** Check whether a preload is in-flight (or resolved) for the given path. */
export function hasPreloadFor(path: string): boolean {
  return current?.path === path;
}

/** Discard the current preload entry (e.g. on workspace change). */
export function clearPreload(): void {
  cleanupCurrentEntry(current);
  current = null;
}

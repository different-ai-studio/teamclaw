/**
 * useAppInit — initialization logic extracted from App.tsx
 *
 * Handles:
 *  - Tauri body class injection
 *  - OpenCode server startup (preloader + workspace restore)
 *  - Channel gateway auto-start / keep-alive
 *  - Git repos auto-sync
 *  - External-link interception (Tauri only)
 *  - Dependency check + setup guide visibility
 *  - Telemetry consent dialog
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { isTauri, openExternalUrl } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";
import { useChannelsStore } from "@/stores/channels";
import { useGitReposStore } from "@/stores/git-repos";
import { useUIStore } from "@/stores/ui";
import { useDepsStore, getSetupDecision, markSetupCompleted } from "@/stores/deps";
import { useTelemetryStore } from "@/stores/telemetry";
import { useTeamOssStore } from "@/stores/team-oss";
import { useShortcutsStore } from "@/stores/shortcuts";
import { useCronStore } from "@/stores/cron";
import { initOpenCodeClient } from "@/lib/opencode/client";
import {
  startOpenCode,
  hasPreloadFor,
} from "@/lib/opencode/preloader";

// ─────────────────────────────────────────────────────────────────────────────
// OpenCode server start / workspace restore
// ─────────────────────────────────────────────────────────────────────────────

export function useOpenCodeInit() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const setWorkspace = useWorkspaceStore((s) => s.setWorkspace);
  const setOpenCodeReady = useWorkspaceStore((s) => s.setOpenCodeReady);
  const [openCodeError, setOpenCodeError] = useState<string | null>(null);

  // Auto-restore last workspace on launch (runs once on mount)
  useEffect(() => {
    if (!workspacePath) {
      try {
        const savedPath = localStorage.getItem("teamclaw-workspace-path");
        if (savedPath) {
          console.log("[App] Restoring workspace from last session:", savedPath);
          setWorkspace(savedPath);
        }
      } catch {
        /* ignore storage errors */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Start OpenCode server when workspace is selected.
  // Uses the shared preloader so that if `start_opencode` was already fired
  // during the splash screen for this same workspace, we reuse the in-flight
  // promise instead of spawning a duplicate sidecar.
  useEffect(() => {
    if (!workspacePath) return;

    setOpenCodeError(null);

    // In web mode, skip Tauri invoke — assume OpenCode server is running externally
    if (!isTauri()) {
      console.log(
        "[Web Mode] Skipping Tauri invoke, OpenCode server should be running externally",
      );
      const url = "http://127.0.0.1:4096";
      initOpenCodeClient({ baseUrl: url, workspacePath });
      setOpenCodeReady(true, url);
      return;
    }

    const alreadyPreloading = hasPreloadFor(workspacePath);
    if (!alreadyPreloading) {
      setOpenCodeReady(false);
    }

    let cancelled = false;

    console.log(
      alreadyPreloading
        ? "[OpenCode] Awaiting preloaded server for:"
        : "[OpenCode] Starting server for:",
      workspacePath,
    );
    startOpenCode(workspacePath)
      .then((status) => {
        if (cancelled) return;
        console.log("[OpenCode] Server started:", status);
        initOpenCodeClient({ baseUrl: status.url, workspacePath });
        setOpenCodeError(null);
        setOpenCodeReady(true, status.url);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("[OpenCode] Failed to start server:", error);
        setOpenCodeError(String(error));
      });

    return () => {
      cancelled = true;
    };
  }, [workspacePath, setOpenCodeReady]);

  return { openCodeError, setOpenCodeError };
}

// ─────────────────────────────────────────────────────────────────────────────
// Channel gateway auto-start / keep-alive
// ─────────────────────────────────────────────────────────────────────────────

export function useChannelGatewayInit() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const openCodeReady = useWorkspaceStore((s) => s.openCodeReady);
  const {
    autoStartEnabledGateways,
    loadConfig: loadChannelsConfig,
    stopAllAndReset,
    keepAliveCheck,
  } = useChannelsStore();
  const hasAutoStarted = useRef(false);
  const prevWorkspaceRef = useRef<string | null>(null);

  // When workspace changes: stop all gateways, reset state, allow re-auto-start
  useEffect(() => {
    if (prevWorkspaceRef.current === null) {
      prevWorkspaceRef.current = workspacePath;
      return;
    }

    if (workspacePath !== prevWorkspaceRef.current) {
      console.log(
        "[App] Workspace changed from",
        prevWorkspaceRef.current,
        "to",
        workspacePath,
      );
      prevWorkspaceRef.current = workspacePath;
      hasAutoStarted.current = false;

      stopAllAndReset().catch((err: unknown) => {
        console.warn("[App] Failed to stop gateways on workspace change:", err);
      });
    }
  }, [workspacePath, stopAllAndReset]);

  // When OpenCode becomes ready: load channel configs and auto-start enabled gateways
  useEffect(() => {
    if (openCodeReady && !hasAutoStarted.current) {
      hasAutoStarted.current = true;
      console.log("[App] OpenCode ready, loading channel configs and auto-starting...");
      loadChannelsConfig()
        .then(() => {
          autoStartEnabledGateways();
        })
        .catch((err: unknown) => {
          console.error("[App] Failed to load channel configs for auto-start:", err);
        });
    }
  }, [openCodeReady, autoStartEnabledGateways, loadChannelsConfig]);

  // Keep-alive: periodically check enabled channels and restart if disconnected/errored
  useEffect(() => {
    if (!openCodeReady) return;
    const keepAliveInterval = setInterval(() => {
      keepAliveCheck().catch((err: unknown) => {
        console.warn("[App] Keep-alive check failed:", err);
      });
    }, 30_000);
    return () => clearInterval(keepAliveInterval);
  }, [openCodeReady, keepAliveCheck]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Git repos auto-sync
// ─────────────────────────────────────────────────────────────────────────────

export function useGitReposInit() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const { initialize: initGitRepos, syncAll: syncGitRepos } = useGitReposStore();
  const hasGitSynced = useRef(false);
  const teamSyncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (workspacePath && !hasGitSynced.current) {
      hasGitSynced.current = true;

      initGitRepos()
        .then(() => {
          syncGitRepos().catch((err: unknown) => {
            console.warn("[App] Git auto-sync failed (non-critical):", err);
          });
        })
        .catch((err: unknown) => {
          console.warn("[App] Git repos init failed (non-critical):", err);
        });

      // Auto-sync team workspace repo on startup + every 5 minutes, and load team shortcuts
      if (isTauri()) {
        import("@tauri-apps/api/core")
          .then(({ invoke }) => {
            invoke("get_team_config")
              .then((config: unknown) => {
                const teamConfig = config as { enabled?: boolean } | null;
                if (teamConfig?.enabled) {
                  const doSync = () => {
                    invoke("team_sync_repo")
                      .then((result: unknown) => {
                        const r = result as { success: boolean; message: string };
                        if (r.success) {
                          console.log("[App] Team repo sync completed (MCP configs updated)");
                        } else {
                          console.warn("[App] Team repo sync skipped:", r.message);
                        }
                      })
                      .catch((err: unknown) => {
                        console.warn("[App] Team repo sync failed (non-critical):", err);
                      });
                  };

                  console.log("[App] Team config found, syncing team repo...");
                  doSync();

                  // Periodic sync every 5 minutes
                  const intervalId = setInterval(() => {
                    console.log("[App] Periodic team repo sync...");
                    doSync();
                  }, 5 * 60 * 1000);
                  teamSyncIntervalRef.current = intervalId;
                }
              })
              .catch((err: unknown) => {
                console.warn("[App] Failed to check team config (non-critical):", err);
              });
          })
          .catch(() => {
            // Tauri not available, skip
          });

        // Load team shortcuts after team config
        import("@/lib/team-shortcuts")
          .then(({ loadTeamShortcutsFile }) => {
            return loadTeamShortcutsFile(workspacePath);
          })
          .then((teamShortcuts) => {
            useShortcutsStore.getState().setTeamNodes(teamShortcuts || []);
          })
          .catch((err: unknown) => {
            console.warn("[App] Failed to load team shortcuts (non-critical):", err);
          });
      }
    }

    return () => {
      if (teamSyncIntervalRef.current) {
        clearInterval(teamSyncIntervalRef.current);
        teamSyncIntervalRef.current = null;
      }
    };
  }, [workspacePath, initGitRepos, syncGitRepos]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron session IDs (for sidebar filtering)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// P2P auto-reconnect (team mode)
// ─────────────────────────────────────────────────────────────────────────────

export function useP2pAutoReconnect() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const openCodeReady = useWorkspaceStore((s) => s.openCodeReady);

  useEffect(() => {
    if (!workspacePath || !openCodeReady || !isTauri()) return;

    // Delay P2P reconnect so it doesn't compete with app startup
    const timer = setTimeout(async () => {
      try {
        const { useTeamModeStore } = await import("@/stores/team-mode");
        if (!useTeamModeStore.getState().teamMode) return;

        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("p2p_reconnect");

        // Update connection status
        const status = await invoke<{ connected?: boolean; role?: string }>("p2p_sync_status").catch(() => null);
        if (status) {
          useTeamModeStore.setState({
            p2pConnected: status.connected ?? false,
            myRole: (status.role as 'owner' | 'editor' | 'viewer') ?? null,
          });
        }
        console.log("[P2P] Auto-reconnect completed");
      } catch (err) {
        console.warn("[P2P] Auto-reconnect failed (non-critical):", err);
      }
    }, 3000);

    return () => clearTimeout(timer);
  }, [workspacePath, openCodeReady]);
}

export function useCronInit() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const openCodeReady = useWorkspaceStore((s) => s.openCodeReady);

  useEffect(() => {
    if (!workspacePath || !openCodeReady) return;
    useCronStore.getState().loadCronSessionIds().catch((err: unknown) => {
      console.warn("[App] Cron session IDs load failed (non-critical):", err);
    });
  }, [workspacePath, openCodeReady]);
}

// ─────────────────────────────────────────────────────────────────────────────
// OSS sync auto-restore
// ─────────────────────────────────────────────────────────────────────────────

export function useOssSyncInit() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const initialize = useTeamOssStore((s) => s.initialize);
  const cleanup = useTeamOssStore((s) => s.cleanup);
  const hasInitialized = useRef(false);

  useEffect(() => {
    if (!workspacePath || !isTauri() || hasInitialized.current) return;
    hasInitialized.current = true;

    initialize(workspacePath).catch((err: unknown) => {
      console.warn("[App] OSS sync init failed (non-critical):", err);
    });

    return () => {
      cleanup();
    };
  }, [workspacePath, initialize, cleanup]);
}

// ─────────────────────────────────────────────────────────────────────────────
// External link interception (Tauri only)
// ─────────────────────────────────────────────────────────────────────────────

export function useExternalLinkHandler() {
  useEffect(() => {
    if (!isTauri()) return;

    const handler = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest?.("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (href && /^https?:\/\//.test(href)) {
        e.preventDefault();
        e.stopPropagation();
        openExternalUrl(href);
      }
    };

    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, []);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri body class
// ─────────────────────────────────────────────────────────────────────────────

export function useTauriBodyClass() {
  useEffect(() => {
    if (isTauri()) {
      document.documentElement.classList.add("tauri");
      return () => document.documentElement.classList.remove("tauri");
    }
  }, []);
}

// ─────────────────────────────────────────────────────────────────────────────
// Dependency check / setup guide
// ─────────────────────────────────────────────────────────────────────────────

export function useSetupGuide(openCodeReady: boolean) {
  const [showSetupGuide, setShowSetupGuide] = useState(false);
  const {
    dependencies,
    checkDependencies,
  } = useDepsStore();
  const depsResultRef = useRef<{ checked: boolean; hasRequiredMissing: boolean }>({
    checked: false,
    hasRequiredMissing: false,
  });
  const setupDecisionRef = useRef(getSetupDecision());

  // Dependency check — deferred until OpenCode is ready to avoid CPU contention
  useEffect(() => {
    const debugForceSetup = (() => {
      try {
        return localStorage.getItem("teamclaw-debug-force-setup") === "1";
      } catch {
        return false;
      }
    })();

    if (!isTauri() && !debugForceSetup) return;

    const decision = setupDecisionRef.current;

    if (decision === "skip") {
      depsResultRef.current = { checked: true, hasRequiredMissing: false };
      return;
    }

    // Wait for OpenCode to be ready before checking deps (reduces startup CPU contention)
    if (!openCodeReady && isTauri()) return;

    console.log("[Setup] Checking dependencies (decision:", decision, ")");
    checkDependencies().then((result) => {
      const hasRequiredMissing = result.some((d) => d.required && !d.installed);
      depsResultRef.current = { checked: true, hasRequiredMissing };
      if (hasRequiredMissing && (decision === "show" || decision === "silent-check")) {
        setShowSetupGuide(true);
      }
    });
  }, [openCodeReady, checkDependencies]);

  const handleRecheck = useCallback(async () => {
    return checkDependencies();
  }, [checkDependencies]);

  const handleSetupContinue = useCallback(() => {
    markSetupCompleted();
    setShowSetupGuide(false);
  }, []);

  return { showSetupGuide, dependencies, handleRecheck, handleSetupContinue };
}

// ─────────────────────────────────────────────────────────────────────────────
// Telemetry consent dialog
// ─────────────────────────────────────────────────────────────────────────────

export function useTelemetryConsent(showSetupGuide: boolean) {
  const [showConsentDialog, setShowConsentDialog] = useState(false);
  const telemetryConsent = useTelemetryStore((s) => s.consent);
  const telemetryInit = useTelemetryStore((s) => s.init);
  const telemetryInitialized = useTelemetryStore((s) => s.isInitialized);

  // Initialize telemetry on mount
  useEffect(() => {
    telemetryInit();
  }, [telemetryInit]);

  // Show consent dialog after setup is done if consent is undecided
  useEffect(() => {
    if (!showSetupGuide && telemetryInitialized && telemetryConsent === "undecided") {
      setShowConsentDialog(true);
    }
  }, [showSetupGuide, telemetryInitialized, telemetryConsent]);

  return { showConsentDialog, setShowConsentDialog };
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenCode preload (fires start_opencode early during mount)
// ─────────────────────────────────────────────────────────────────────────────

export function useOpenCodePreload() {
  useEffect(() => {
    if (!isTauri()) return;
    const savedPath = localStorage.getItem("teamclaw-workspace-path");
    if (savedPath) {
      console.log("[Preload] Starting OpenCode for:", savedPath);
      startOpenCode(savedPath).catch((err) =>
        console.warn("[Preload] OpenCode pre-start failed (will retry later):", err),
      );
    }
  }, []);
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout mode keyboard shortcut + panel auto-open
// ─────────────────────────────────────────────────────────────────────────────

export function useLayoutModeShortcut() {
  const toggleLayoutMode = useUIStore((s) => s.toggleLayoutMode);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        if (!useUIStore.getState().advancedMode) return;
        e.preventDefault();
        toggleLayoutMode();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleLayoutMode]);
}

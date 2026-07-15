import { create, type StoreApi } from "zustand";
import { getBackend } from "@/lib/backend";
import { seedDaemonApp, buildDaemonApp } from "@/lib/daemon-local-client";
import type { AppRow } from "@/lib/backend/types";

interface AppsState {
  items: AppRow[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  teamId: string | null;
  /** App ids with a deploy in flight — drives per-row spinner / disabled state. */
  deployingIds: string[];
  load: (teamId: string, opts?: { force?: boolean }) => Promise<void>;
  create: (input: {
    teamId: string;
    name: string;
    type: string;
    visibility: "personal" | "team";
  }) => Promise<AppRow>;
  reseed: (appId: string) => Promise<void>;
  /** Full FC deploy: startDeploy → daemon build+upload → finalize. */
  deploy: (appId: string) => Promise<void>;
  rename: (appId: string, name: string) => Promise<void>;
}

type SetState = StoreApi<AppsState>["setState"];

/** Merge a fresh app row (from create/deploy/rename responses) into the store. */
function mergeRow(set: SetState, row: AppRow): void {
  set((s) => ({ items: s.items.map((a) => (a.id === row.id ? row : a)) }));
}

async function toastError(title: string, description?: string): Promise<void> {
  const { toast } = await import("sonner");
  toast.error(title, description ? { description } : undefined);
}

async function toastSuccess(title: string, description?: string): Promise<void> {
  const { toast } = await import("sonner");
  toast.success(title, description ? { description } : undefined);
}

/**
 * Write a terminal provision status back to the cloud API and patch the matching
 * row in the store. Non-fatal: a failed writeback must never reject the caller
 * (app creation / reseed has already succeeded locally).
 */
async function patchStatus(set: SetState, appId: string, status: string): Promise<void> {
  try {
    const updated = await getBackend().apps.updateAppProvisionStatus(appId, status);
    if (updated) set((s) => ({ items: s.items.map((a) => (a.id === appId ? updated : a)) }));
  } catch (e) {
    console.warn("app status writeback failed (non-fatal)", e);
  }
}

/**
 * Kick the local daemon seed and write back the terminal status. The desktop
 * writes ONLY `ready`/`error`; `unreachable` writes nothing so the row stays at
 * `repo_created` and a reseed remains available.
 */
async function runSeed(
  set: SetState,
  appId: string,
  gitRemoteUrl: string,
  teamId: string,
): Promise<void> {
  let outcome: "seeded" | "failed" | "unreachable" = "unreachable";
  try {
    outcome = await seedDaemonApp(appId, gitRemoteUrl, teamId);
  } catch (e) {
    console.warn("app seed kick failed (non-fatal)", e);
  }
  if (outcome === "seeded") await patchStatus(set, appId, "ready");
  else if (outcome === "failed") await patchStatus(set, appId, "error");
  // unreachable → no status change; reseed remains available.
}

export const useAppsStore = create<AppsState>((set, get) => ({
  items: [],
  loaded: false,
  loading: false,
  error: null,
  teamId: null,
  deployingIds: [],
  load: async (teamId, opts) => {
    const s = get();
    if (s.loaded && s.teamId === teamId && !opts?.force) return;
    set({ loading: true, error: null, teamId });
    try {
      const items = await getBackend().apps.listApps(teamId);
      set({ items, loaded: true, loading: false });
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : "failed to load apps",
      });
    }
  },
  create: async (input) => {
    const row = await getBackend().apps.createApp(input);
    set((s) => ({ items: [row, ...s.items] }));
    // Once the cloud API has created the managed-git repo, kick the local daemon
    // to seed the starter template into it, then write the terminal status back.
    // Non-fatal — a daemon that is down (unreachable) leaves the row at
    // `repo_created` so the user can reseed later.
    if (row.provisionStatus === "repo_created" && row.gitRemoteUrl) {
      await runSeed(set, row.id, row.gitRemoteUrl, row.teamId);
    }
    return row;
  },
  reseed: async (appId) => {
    const app = get().items.find((a) => a.id === appId);
    if (!app || !app.gitRemoteUrl) return;
    await runSeed(set, app.id, app.gitRemoteUrl, app.teamId);
  },
  deploy: async (appId) => {
    const app = get().items.find((a) => a.id === appId);
    if (!app) return;
    if (get().deployingIds.includes(appId)) return;
    if (app.provisionStatus !== "ready") {
      await toastError("应用尚未就绪，无法部署");
      return;
    }
    set((s) => ({ deployingIds: [...s.deployingIds, appId] }));
    try {
      // 1. Cloud: provision the FC function + DB schema, mint the OSS upload URL.
      const started = await getBackend().apps.deployApp(appId);
      mergeRow(set, started);

      // 2. Local daemon: build the artifact in the app workdir + upload to OSS.
      const outcome = await buildDaemonApp(appId, app.teamId, started.presignedPut);
      if (outcome !== "built") {
        await toastError(
          "部署失败：构建未完成",
          outcome === "unreachable"
            ? "本机 amuxd 未连接，无法构建。请确认守护进程在运行后重试。"
            : "应用构建或上传失败，请查看日志后重试。",
        );
        return;
      }

      // 3. Cloud: point the function at the uploaded code, get the live endpoint.
      const finalized = await getBackend().apps.finalizeDeploy(appId);
      mergeRow(set, finalized);
      await toastSuccess(
        "部署成功",
        finalized.fcEndpoint ? finalized.fcEndpoint : undefined,
      );
    } catch (e) {
      await toastError("部署失败", e instanceof Error ? e.message : String(e));
    } finally {
      set((s) => ({ deployingIds: s.deployingIds.filter((id) => id !== appId) }));
    }
  },
  rename: async (appId, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const updated = await getBackend().apps.renameApp(appId, trimmed);
      if (updated) mergeRow(set, updated);
    } catch (e) {
      await toastError("重命名失败", e instanceof Error ? e.message : String(e));
    }
  },
}));

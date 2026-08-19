import { create, type StoreApi } from "zustand";
import { getBackend } from "@/lib/backend";
import { seedDaemonApp, buildDaemonApp, type SeedAppResult } from "@/lib/daemon-local-client";
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
    /** Optional repo to import — the app is cloned from it instead of seeded
     *  with a starter template. */
    gitRemoteUrl?: string | null;
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
 * Report a failed deploy back to the cloud API so `fc_status` lands on
 * `deploy_error` with a reason. The desktop drives the middle of the deploy (it
 * kicks the daemon build), so nothing else can tell the cloud the build never
 * finished — without this the row stays at `awaiting_build` forever and the
 * next finalize is rejected as an illegal transition. Non-fatal: the user is
 * already being toasted about the failure.
 */
async function reportDeployError(set: SetState, appId: string, reason: string): Promise<void> {
  try {
    const updated = await getBackend().apps.updateAppDeployStatus(appId, "deploy_error", reason);
    if (updated) mergeRow(set, updated);
  } catch (e) {
    console.warn("deploy error writeback failed (non-fatal)", e);
  }
}

/**
 * Kick the local daemon seed and write back the terminal status. The desktop
 * writes ONLY `ready`/`error`; `unreachable` writes nothing so the row stays
 * `pending` and a reseed remains available.
 *
 * The daemon reports the directory it wrote to, and that path is written onto
 * the app's own cloud workspace row right here — before any session exists.
 * Leaving it for the session-open path meant the app's workspace stayed
 * path-less until then, and a path-less workspace is one the daemon resolves by
 * falling back to whatever folder the desktop had open.
 *
 * A clone that fails is the one case worth interrupting the user for: they
 * typed the URL, and the app is empty until they fix it.
 */
async function runSeed(set: SetState, app: AppRow): Promise<void> {
  let result: SeedAppResult = { outcome: "unreachable", workdir: null, error: null };
  try {
    result = await seedDaemonApp(app.id, app.teamId, app.name, app.type, app.gitRemoteUrl);
  } catch (e) {
    console.warn("app seed kick failed (non-fatal)", e);
  }
  if (result.outcome === "seeded") {
    if (result.workdir) {
      // Dynamic: app-session pulls in the session-creation chain, which reads
      // this store.
      const { bindAppWorkdir } = await import("@/lib/app-session");
      await bindAppWorkdir(app, result.workdir);
    }
    await patchStatus(set, app.id, "ready");
  } else if (result.outcome === "failed") {
    await patchStatus(set, app.id, "error");
    if (app.gitRemoteUrl) {
      await toastError("仓库克隆失败", result.error ?? undefined);
    }
  }
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
    // The cloud API only inserts the row; the app's files come from the local
    // daemon, which writes its own embedded template. Non-fatal — a daemon that
    // is down (unreachable) leaves the row `pending` so the user can reseed.
    if (row.provisionStatus === "pending" || row.provisionStatus === "repo_created") {
      await runSeed(set, row);
    }
    // Return the row as it stands AFTER seeding — the caller decides what to do
    // next based on whether the app actually has its files.
    return get().items.find((a) => a.id === row.id) ?? row;
  },
  reseed: async (appId) => {
    const app = get().items.find((a) => a.id === appId);
    if (!app) return;
    await runSeed(set, app);
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
        const reason =
          outcome === "unreachable"
            ? "本机 amuxd 未连接，无法构建。请确认守护进程在运行后重试。"
            : "应用构建或上传失败，请查看日志后重试。";
        await reportDeployError(set, appId, reason);
        await toastError("部署失败：构建未完成", reason);
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
      const reason = e instanceof Error ? e.message : String(e);
      // The cloud already marks its own failures; this covers the ones it
      // cannot see (the daemon leg, and anything thrown in between).
      await reportDeployError(set, appId, reason);
      await toastError("部署失败", reason);
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

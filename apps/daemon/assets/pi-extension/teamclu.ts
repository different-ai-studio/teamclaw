/**
 * TeamClu pi extension — permission gate + amuxd remote-tools MCP bridge.
 *
 * Shipped inside amuxd (include_str!), materialized to
 * `~/.amuxd/pi/extensions/teamclu.ts` at pi spawn and loaded via `-e <path>`.
 *
 * ## Env contract (set by amuxd `pi_rpc/process.rs` at spawn)
 *
 * - `TEAMCLU_PI_PERMISSIONS_FILE` — absolute path to a JSON rules file:
 *       { "defaultAction": "ask" | "allow", "alwaysAllowed": ["ls *", "edit", ...] }
 *   Re-read on every tool call (the daemon appends patterns to it when the
 *   host approves a permission with option_id "always"). Missing or invalid
 *   file ⇒ { defaultAction: "ask", alwaysAllowed: [] }.
 *   Pattern semantics: for `bash` the match key is the command string, for
 *   every other tool it is the tool name. A pattern ending in " *" is a
 *   prefix match on the first word(s); otherwise exact string equality.
 *
 * - `TEAMCLU_REMOTE_TOOLS_CMD` — JSON array, e.g.
 *       ["/path/to/amuxd", "remote-tools-mcp", "--sock=/path/amuxd.sock"]
 *   A stdio MCP server (newline-delimited JSON-RPC). When set, the extension
 *   spawns it, lists its tools, and registers each as a pi tool proxying
 *   tools/call. Unset ⇒ no bridge.
 *
 * ## Permission flow
 *
 * `tool_call` hook: on "ask" the extension calls `ctx.ui.confirm(title, message)`.
 * In `pi --mode rpc` that surfaces as `extension_ui_request{method:"confirm"}`
 * which amuxd translates into an AcpPermissionRequest. The message carries a
 * machine-readable trailer line `teamclu.always-pattern=<pattern>`; when the
 * host approves with "always", the daemon appends that pattern to the rules
 * file (the dialog reply itself only carries a confirmed boolean).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

// Loose ExtensionAPI typing: keeps this file dependency-free (the real types
// live in @earendil-works/pi-coding-agent; runtime shape is what matters).
type ToolCallEvent = {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
};
type ExtensionContext = {
  ui: {
    confirm(title: string, message?: string, options?: { timeout?: number }): Promise<boolean>;
    select(
      title: string,
      options: string[],
      opts?: { timeout?: number; signal?: AbortSignal },
    ): Promise<string | undefined>;
  };
};
type ExtensionAPI = {
  on(
    event: "tool_call",
    handler: (
      event: ToolCallEvent,
      ctx: ExtensionContext,
    ) => Promise<{ block: boolean; reason?: string } | undefined>,
  ): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      // pi's real signature continues (onUpdate, ctx); the question tool needs
      // ctx.ui, the MCP proxies ignore both.
      onUpdate?: unknown,
      ctx?: ExtensionContext,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
  }): void;
  registerProvider(id: string, config: Record<string, unknown>): void;
};

// ---------------------------------------------------------------------------
// Permission rules
// ---------------------------------------------------------------------------

interface Rules {
  defaultAction: "ask" | "allow";
  alwaysAllowed: string[];
}

function loadRules(): Rules {
  const fallback: Rules = { defaultAction: "ask", alwaysAllowed: [] };
  const path = process.env.TEAMCLU_PI_PERMISSIONS_FILE;
  if (!path) return fallback;
  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
    return {
      defaultAction: parsed.defaultAction === "allow" ? "allow" : "ask",
      alwaysAllowed: Array.isArray(parsed.alwaysAllowed)
        ? parsed.alwaysAllowed.filter((p: unknown) => typeof p === "string")
        : [],
    };
  } catch {
    return fallback; // missing/corrupt file: fail closed to "ask"
  }
}

/** Match key: bash → the command string; other tools → the tool name. */
function matchKey(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash" && typeof input.command === "string") return input.command.trim();
  return toolName;
}

/** Persisted "always allow" pattern for this call (what the daemon appends). */
function alwaysPattern(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash" && typeof input.command === "string") {
    const first = input.command.trim().split(/\s+/)[0] ?? "";
    return first ? `${first} *` : "bash";
  }
  return toolName;
}

/** "ls *" prefix-matches "ls -la"; a pattern without "*" is exact equality. */
function patternMatches(pattern: string, key: string): boolean {
  if (pattern.endsWith(" *")) {
    const prefix = pattern.slice(0, -2);
    return key === prefix || key.startsWith(prefix + " ");
  }
  if (pattern === "*") return true;
  return pattern === key;
}

/** One-line summary for the confirm dialog title. */
function summarize(toolName: string, input: Record<string, unknown>): string {
  const candidates = ["command", "path", "file_path", "url", "pattern"];
  for (const k of candidates) {
    const v = input[k];
    if (typeof v === "string" && v.length > 0) return v.split("\n")[0].slice(0, 120);
  }
  const json = JSON.stringify(input) ?? "{}";
  return json.slice(0, 120);
}

// ---------------------------------------------------------------------------
// Minimal stdio MCP client (newline-delimited JSON-RPC, no deps)
// ---------------------------------------------------------------------------

class McpBridge {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buffer = "";
  /** First fatal error seen (spawn failure or child exit). Once set, every
   *  request fails immediately instead of writing to a dead pipe. */
  private failure: Error | null = null;

  constructor(cmd: string[], env?: Record<string, string>) {
    this.child = spawn(cmd[0], cmd.slice(1), {
      stdio: ["pipe", "pipe", "inherit"],
      env: env ? { ...process.env, ...env } : process.env,
    });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => this.onData(chunk));
    // A ChildProcess "error" event with NO listener is an uncaught exception in
    // node — it takes the whole pi process down, before `host_ready` and before
    // any response. That is how one stale entry in the workspace MCP config (a
    // renamed binary, an absolute path from another machine) turned every
    // session in that workspace into "pi exited before responding". Bridging is
    // best-effort by design (`bridgeMcpServer` catches and carries on); this
    // listener is what lets that catch ever run.
    this.child.on("error", (e: unknown) => {
      this.fail(e instanceof Error ? e : new Error(String(e)));
    });
    this.child.on("exit", (code, signal) => {
      this.fail(
        new Error(`MCP server "${cmd[0]}" exited (code=${code ?? "null"} signal=${signal ?? "null"})`),
      );
    });
  }

  /** Record the first fatal error and fail everything in flight. */
  private fail(err: Error): void {
    if (!this.failure) this.failure = err;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  /** Kill the child and fail anything still in flight. Used when a server's
   *  command changed or it was removed from the config. */
  dispose(): void {
    this.fail(new Error("MCP bridge disposed"));
    try {
      this.child.kill();
    } catch {
      // Already gone: nothing to do.
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (typeof msg.id === "number" && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
          else p.resolve(msg.result);
        }
      } catch {
        // non-JSON noise on stdout: ignore
      }
    }
  }

  request(method: string, params?: unknown, timeoutMs = 60_000): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.child.stdin!.write(payload + "\n");
      } catch (e) {
        // Dead pipe (child already gone): reject rather than throw out of the
        // executor, so the caller sees a normal bridge failure.
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.failure) return;
    try {
      this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }) + "\n");
    } catch {
      // Same as `request`: a dead bridge is not a fatal condition.
    }
  }
}

// ---------------------------------------------------------------------------
// Team shared LLM provider
// ---------------------------------------------------------------------------

/**
 * Register the team's shared LLM gateway as a pi provider, mirroring how
 * opencode gets `provider.team`. amuxd sets `TEAMCLU_TEAM_PROVIDER` (from the
 * cloud-resolved managed LLM) to a JSON payload:
 *   { name, baseUrl, apiKeyEnv, models: [{ id, name }] }
 * The secret is never embedded — `apiKeyEnv` names an env var (`tc_api_key`,
 * derived from actor_id, already injected by amuxd) that pi interpolates via
 * `${...}`, the same key opencode uses. Absent/invalid env ⇒ no-op.
 */
function registerTeamProvider(pi: ExtensionAPI): void {
  const raw = process.env.TEAMCLU_TEAM_PROVIDER;
  if (!raw) return;
  let cfg: {
    name?: string;
    baseUrl?: string;
    apiKeyEnv?: string;
    models?: Array<{ id?: string; name?: string }>;
  };
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    console.error(`[teamclu] invalid TEAMCLU_TEAM_PROVIDER: ${e}`);
    return;
  }
  if (!cfg.baseUrl || !Array.isArray(cfg.models) || cfg.models.length === 0) return;
  const apiKeyEnv = cfg.apiKeyEnv || "tc_api_key";
  const models = cfg.models
    .filter((m) => m && m.id)
    .map((m) => ({
      id: m.id as string,
      name: m.name || (m.id as string),
      reasoning: false,
      input: ["text"] as string[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 256000,
      maxTokens: 16000,
    }));
  if (models.length === 0) return;
  try {
    pi.registerProvider("team", {
      name: cfg.name || "Team",
      baseUrl: cfg.baseUrl,
      apiKey: `\${${apiKeyEnv}}`,
      api: "openai-completions",
      models,
    });
  } catch (e) {
    console.error(`[teamclu] registerProvider(team) failed: ${e}`);
  }
}

// ---------------------------------------------------------------------------
// MCP server bridge (pi has no native MCP)
// ---------------------------------------------------------------------------

/** Resolve `${VAR}` / `$VAR` references in a server's environment map against
 *  the pi process env (which amuxd populated with team/personal secrets). */
function resolveEnv(env: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env) return out;
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") continue;
    out[k] = v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a, b) => {
      const name = a || b;
      return process.env[name] ?? "";
    });
  }
  return out;
}

/**
 * Process-wide MCP bridge registry.
 *
 * # Why this is global rather than per-extension-instance
 *
 * pi runs this extension's entry point again for every new session, on the SAME
 * process. Each run used to spawn a fresh child for every configured server and
 * leave the previous ones running: a live process tree showed one `pi` with two
 * complete sets of MCP children, and a third session would have added a third.
 *
 * The cost was the whole of the "first message is slow" complaint. Measured on
 * this machine, `new_session` scaled linearly with the number of npx-based
 * servers — ~4s each, serially:
 *
 *   0 npx servers →   ~50ms
 *   1 npx server  →  ~4100ms
 *   3 npx servers → ~11000ms
 *
 * Keyed on `globalThis` rather than a module-level `const` because a re-import
 * would give the module fresh state, and re-import is exactly the case this has
 * to survive.
 */
type McpTool = { name: string; description?: string; inputSchema?: unknown };

type BridgeEntry = {
  /** Resolves once the child has completed the MCP handshake. Held as a
   *  promise, not a value, because a cache hit registers tools before the
   *  child is even spawned. */
  ready: Promise<McpBridge>;
  /** The command that produced this bridge; a change means respawn. */
  signature: string;
  tools: McpTool[];
  /** `tools` came from the on-disk cache and no live `tools/list` has
   *  confirmed it yet. */
  provisional: boolean;
};

const BRIDGE_REGISTRY: Map<string, BridgeEntry> = ((globalThis as any).__teamcluMcpBridges ??=
  new Map());

function bridgeSignature(cmd: string[], env?: Record<string, string>): string {
  return JSON.stringify([cmd, env ?? {}]);
}

// ---------------------------------------------------------------------------
// tools/list cache
// ---------------------------------------------------------------------------

/**
 * Why this cache exists.
 *
 * pi cannot start a session until the extension's entry point returns, and the
 * entry point cannot register a server's tools until `tools/list` answers —
 * which means spawning the child and completing the MCP handshake first. Timed
 * inside pi on this machine, that is where the cold first message goes:
 *
 *   pi boot -> extension loaded    1.05s
 *   remote-tools bridge            0.03s
 *   teamclu-introspect bridge      0.03s
 *   playwright bridge              1.94s
 *   chrome-control bridge          2.14s
 *   autoui bridge                  4.25s   <- the whole wait is this one
 *   entry done                     5.33s
 *
 * The tool list is the only part the entry point actually needs, and it barely
 * changes between runs. Cached on disk it registers instantly and the child is
 * spawned in the background, taking the slowest server off the critical path.
 * A tool call that arrives before its child is ready simply awaits `ready`.
 */
const TOOL_CACHE_DIR = process.env.TEAMCLU_MCP_TOOL_CACHE_DIR;

/** Stable per-signature filename. FNV-1a: no crypto import, and collisions only
 *  cost a cache miss because the stored signature is compared on read. */
function cacheKey(signature: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < signature.length; i++) {
    h ^= signature.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function cachePath(label: string, signature: string): string | null {
  if (!TOOL_CACHE_DIR) return null;
  const safe = label.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${TOOL_CACHE_DIR}/${safe}.${cacheKey(signature)}.json`;
}

function readToolCache(label: string, signature: string): McpTool[] | null {
  const p = cachePath(label, signature);
  if (!p) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    // The signature is stored as well as hashed: a hash collision, or a stale
    // file from an older command, must miss rather than register wrong tools.
    if (parsed?.signature !== signature) return null;
    const tools = parsed?.tools;
    if (!Array.isArray(tools) || tools.length === 0) return null;
    return tools.filter((t: any) => t && typeof t.name === "string");
  } catch {
    return null;
  }
}

function writeToolCache(label: string, signature: string, tools: McpTool[]): void {
  const p = cachePath(label, signature);
  if (!p || tools.length === 0) return;
  try {
    fs.writeFileSync(p, JSON.stringify({ signature, tools }));
  } catch (e) {
    console.error(`[teamclu] MCP tool cache write failed (${label}): ${e}`);
  }
}

/** Spawn the child and complete the MCP handshake. */
async function handshake(
  cmd: string[],
  env?: Record<string, string>,
): Promise<{ bridge: McpBridge; tools: McpTool[] }> {
  const bridge = new McpBridge(cmd, env);
  try {
    await bridge.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "teamclu-pi-extension", version: "1.0.0" },
    });
    bridge.notify("notifications/initialized");
    const listed = await bridge.request("tools/list");
    return { bridge, tools: listed?.tools ?? [] };
  } catch (e) {
    bridge.dispose(); // never leak a child whose handshake failed
    throw e;
  }
}

/**
 * Get a bridge entry for `label`, spawning only when there is not already one
 * with the same command. A changed command tears the old child down first —
 * that is what makes an MCP config edit take effect without restarting pi.
 *
 * Returns as soon as a tool list is known: from the live registry, from the
 * on-disk cache (child spawning in the background), or — only on the very
 * first run for a given command — from a full handshake.
 */
async function ensureBridge(
  label: string,
  cmd: string[],
  env?: Record<string, string>,
): Promise<BridgeEntry> {
  const signature = bridgeSignature(cmd, env);
  const existing = BRIDGE_REGISTRY.get(label);
  if (existing) {
    if (existing.signature === signature) return existing;
    disposeEntry(existing);
    BRIDGE_REGISTRY.delete(label);
  }

  const cached = readToolCache(label, signature);
  if (cached) {
    const pending = handshake(cmd, env);
    const entry: BridgeEntry = {
      ready: pending.then((r) => r.bridge),
      signature,
      tools: cached,
      provisional: true,
    };
    BRIDGE_REGISTRY.set(label, entry);
    // Derived chain, so `entry.ready` keeps its own rejection for awaiting
    // tool calls instead of being swallowed here.
    void pending.then(
      ({ tools }) => {
        entry.tools = tools;
        entry.provisional = false;
        writeToolCache(label, signature, tools);
      },
      (e) => {
        // Drop the entry so the next session retries rather than inheriting a
        // bridge that will never answer.
        if (BRIDGE_REGISTRY.get(label) === entry) BRIDGE_REGISTRY.delete(label);
        console.error(`[teamclu] MCP bridge failed after cached start (${label}): ${e}`);
      },
    );
    return entry;
  }

  const { bridge, tools } = await handshake(cmd, env);
  writeToolCache(label, signature, tools);
  const entry: BridgeEntry = {
    ready: Promise.resolve(bridge),
    signature,
    tools,
    provisional: false,
  };
  BRIDGE_REGISTRY.set(label, entry);
  return entry;
}

function disposeEntry(entry: BridgeEntry): void {
  // The child may still be starting; dispose when it lands either way.
  void entry.ready.then(
    (b) => b.dispose(),
    () => {},
  );
}

/** Tear down bridges whose server is no longer configured. */
function disposeRemovedBridges(configured: Set<string>): void {
  for (const [label, entry] of [...BRIDGE_REGISTRY]) {
    if (configured.has(label)) continue;
    disposeEntry(entry);
    BRIDGE_REGISTRY.delete(label);
  }
}

type McpServerSpec = { command: string[]; environment?: Record<string, unknown> };

/**
 * Read the workspace MCP config the same way amuxd does when it builds
 * `TEAMCLU_MCP_SERVERS` (`mcp_servers_from_value` in `pi_rpc/mod.rs`): skip the
 * daemon's own remote-tools entry, skip `type: "remote"` and `enabled: false`,
 * and require a non-empty string `command` array.
 *
 * Kept deliberately in sync with the Rust side — the env payload is a snapshot
 * of this file at spawn, so a watcher re-reading it must apply the same rules
 * or a reload would bridge servers the initial pass rejected.
 *
 * Returns `null` when the file cannot be read or parsed, which the caller must
 * treat as "no information" rather than "no servers". Editors save atomically
 * (write temp, rename), so a read can land mid-write; answering `{}` there
 * would tear down every working bridge over a transient half-written file, and
 * nothing would bring them back until the next edit.
 */
function readMcpServers(configPath: string): Record<string, McpServerSpec> | null {
  let root: any;
  try {
    root = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
  // Valid JSON with no `mcp` section genuinely means "no servers".
  const mcp = root?.mcp;
  if (!mcp || typeof mcp !== "object") return {};
  const out: Record<string, McpServerSpec> = {};
  for (const [name, raw] of Object.entries(mcp)) {
    if (name === "amuxd-remote-tools") continue;
    const spec = raw as any;
    if (!spec || typeof spec !== "object") continue;
    if (spec.type === "remote") continue;
    if (spec.enabled === false) continue;
    const cmd = spec.command;
    if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((c: unknown) => typeof c === "string")) {
      continue;
    }
    out[name] = { command: cmd as string[], environment: spec.environment };
  }
  return out;
}

/** Bring the live bridges in line with `servers`: drop what is gone, spawn what
 *  is new, leave unchanged ones alone (the registry decides by signature). */
async function reconcileBridges(
  pi: ExtensionAPI,
  ownTools: Set<string>,
  servers: Record<string, McpServerSpec>,
): Promise<void> {
  const names = Object.keys(servers);
  // "remote-tools" is bridged from its own env contract, not from this file.
  disposeRemovedBridges(new Set([...names, "remote-tools"]));
  await Promise.all(
    names.map((name) =>
      bridgeMcpServer(pi, ownTools, name, servers[name].command, resolveEnv(servers[name].environment)),
    ),
  );
}

/**
 * The extension instance a config reload should register new tools on.
 *
 * `pi.registerTool` binds to the instance that is passed to the entry point,
 * and the entry point runs again per session — so the watcher, which outlives
 * any one session, cannot capture a `pi` and keep it. It reads the newest one
 * from here instead, which the entry point refreshes on every run.
 */
const WATCH_STATE: { target: { pi: ExtensionAPI; ownTools: Set<string> } | null; started: boolean } =
  ((globalThis as any).__teamcluMcpWatchState ??= { target: null, started: false });

/**
 * Watch the workspace MCP config and re-bridge on edit.
 *
 * Without this an MCP config change only lands when the pi process itself is
 * replaced, because `TEAMCLU_MCP_SERVERS` is read once at spawn. Watching the
 * *directory* rather than the file is deliberate: editors write config atomically
 * (write temp + rename), which detaches an `fs.watch` bound to the old inode and
 * silently stops delivering events.
 *
 * Idempotent and process-wide: the entry point calls it every session, and only
 * the first call installs anything.
 */
function ensureMcpConfigWatcher(): void {
  if (WATCH_STATE.started) return;
  const configPath = process.env.TEAMCLU_MCP_CONFIG_PATH;
  if (!configPath) return;
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    fs.watch(dir, (_event, filename) => {
      // A rename fires for the temp file too; only the real name matters.
      if (filename && filename !== base) return;
      if (timer) clearTimeout(timer);
      // One save can fire several events (truncate, write, rename).
      timer = setTimeout(() => {
        timer = null;
        const target = WATCH_STATE.target;
        if (!target) return;
        const servers = readMcpServers(configPath);
        if (!servers) {
          console.error(`[teamclu] MCP config unreadable; keeping current bridges: ${configPath}`);
          return;
        }
        void reconcileBridges(target.pi, target.ownTools, servers).catch((e) =>
          console.error(`[teamclu] MCP config reload failed: ${e}`),
        );
      }, 250);
    });
    WATCH_STATE.started = true;
  } catch (e) {
    // No watch ⇒ config changes need a pi restart, as before. Not fatal.
    console.error(`[teamclu] MCP config watch unavailable (${configPath}): ${e}`);
  }
}

/** Reuse (or spawn) one stdio MCP server and register its tools on `pi`.
 *  Best-effort: a failed server never breaks the others. */
async function bridgeMcpServer(
  pi: ExtensionAPI,
  ownTools: Set<string>,
  label: string,
  cmd: string[],
  env?: Record<string, string>,
): Promise<void> {
  try {
    const entry = await ensureBridge(label, cmd, env);
    for (const tool of entry.tools) {
      ownTools.add(tool.name);
      pi.registerTool({
        name: tool.name,
        label: tool.name,
        description: tool.description ?? `TeamClu MCP tool ${tool.name} (${label})`,
        // MCP inputSchema is plain JSON Schema; pi's TypeBox parameters are
        // JSON Schema objects at runtime, so pass it through directly.
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
        async execute(_toolCallId, params) {
          // On a cached start the child may still be handshaking; this is the
          // only place that waits for it, and only when a tool is actually used.
          const bridge = await entry.ready;
          const result = await bridge.request("tools/call", {
            name: tool.name,
            arguments: params ?? {},
          });
          const content = Array.isArray(result?.content)
            ? result.content
                .filter((c: any) => c?.type === "text" && typeof c.text === "string")
                .map((c: any) => ({ type: "text" as const, text: c.text }))
            : [];
          return {
            content: content.length ? content : [{ type: "text" as const, text: JSON.stringify(result ?? null) }],
            isError: result?.isError === true,
          };
        },
      });
    }
  } catch (e) {
    // Bridge is best-effort: pi still works without this server's tools.
    console.error(`[teamclu] MCP bridge unavailable (${label}): ${e}`);
  }
}

// ---------------------------------------------------------------------------
// question tool
// ---------------------------------------------------------------------------

/** Marker prefix on a select dialog title that carries a question payload.
 *  Must match `QUESTION_MARKER` in `pi_rpc/translate.rs`. */
const QUESTION_MARKER = "teamclu.question=";

type QuestionSpec = {
  question?: string;
  header?: string;
  options?: Array<{ label?: string; description?: string } | string>;
  multiple?: boolean;
};

function questionOptionLabels(q: QuestionSpec): string[] {
  return (q.options ?? [])
    .map((o) => (typeof o === "string" ? o : (o?.label ?? "")))
    .filter((label) => label.length > 0);
}

function registerQuestionTool(pi: ExtensionAPI, ownTools: Set<string>): void {
  ownTools.add("question");
  pi.registerTool({
    name: "question",
    label: "Question",
    description:
      "Ask the user one or more questions and wait for their answers. Use this when you " +
      "need a decision, a preference, or a piece of information only the user has. Each " +
      "question offers a fixed set of options; the user may also type a custom answer.",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "Questions to ask the user.",
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "The complete question to ask." },
              header: {
                type: "string",
                description: "Very short label for the question (a few words).",
              },
              options: {
                type: "array",
                description: "The choices offered to the user.",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "Display text of this choice." },
                    description: {
                      type: "string",
                      description: "What choosing this option means.",
                    },
                  },
                  required: ["label"],
                },
              },
              multiple: {
                type: "boolean",
                description: "Allow selecting more than one option.",
              },
            },
            required: ["question"],
          },
        },
      },
      required: ["questions"],
    },
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const questions = Array.isArray(params?.questions)
        ? (params.questions as QuestionSpec[])
        : [];
      if (questions.length === 0) {
        return { content: [{ type: "text", text: "No questions provided." }], isError: true };
      }
      if (!ctx) {
        return {
          content: [{ type: "text", text: "Question UI unavailable in this run mode." }],
          isError: true,
        };
      }
      const payload = JSON.stringify({ toolCallId, questions });
      // Flattened labels keep the dialog renderable by a plain select UI; the
      // TeamClu host reads the marker payload instead.
      const flatLabels = questionOptionLabels(questions[0] ?? {});
      const value = await ctx.ui.select(`${QUESTION_MARKER}${payload}`, flatLabels, { signal });
      if (value === undefined) {
        return {
          content: [{ type: "text", text: "The user dismissed the question without answering." }],
          isError: true,
        };
      }
      // amuxd answers with `[["label", …], …]` (one array per question, in
      // order); a bare string is a plain select's answer to question 1.
      let answers: string[][];
      try {
        const parsed = JSON.parse(value);
        answers = Array.isArray(parsed)
          ? parsed.map((a: unknown) =>
              Array.isArray(a) ? a.map(String) : a === undefined || a === null ? [] : [String(a)],
            )
          : [[String(parsed)]];
      } catch {
        answers = [[value]];
      }
      const lines = questions.map((q, i) => {
        const answer = answers[i] ?? [];
        const label = q.header || q.question || `Question ${i + 1}`;
        return `${label}: ${answer.length > 0 ? answer.join(", ") : "(no answer)"}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
  // Team shared LLM — register before startup finishes so its models appear.
  registerTeamProvider(pi);

  // Tools this extension registered itself (remote-tools proxies). They are
  // daemon-provided, already trusted — skip the permission gate for them.
  const ownTools = new Set<string>();

  // -- `question` tool ---------------------------------------------------------
  // Parity with opencode's built-in question tool: the agent asks the user one
  // or more multiple-choice questions and blocks on the answer. pi has no such
  // tool, but its extension UI channel has `select` — so the whole question
  // payload rides a select dialog's title behind a machine-readable marker.
  // amuxd (`pi_rpc/events.rs`) recognizes the marker, renders the interactive
  // card, and replies with the answers JSON as the select's `value`. A plain
  // select response (no JSON) still works: it is treated as the answer to the
  // first question, which is what a TUI select would produce.
  registerQuestionTool(pi, ownTools);

  // -- Permission gate -------------------------------------------------------
  pi.on("tool_call", async (event, ctx) => {
    if (ownTools.has(event.toolName)) return undefined;

    const rules = loadRules(); // re-read per call: daemon appends "always" grants
    if (rules.defaultAction === "allow") return undefined;

    const key = matchKey(event.toolName, event.input ?? {});
    if (rules.alwaysAllowed.some((p) => patternMatches(p, key))) return undefined;

    const pattern = alwaysPattern(event.toolName, event.input ?? {});
    const title = `${event.toolName}: ${summarize(event.toolName, event.input ?? {})}`;
    // Trailer line is machine-read by amuxd (and its "always" substring makes
    // the host offer an "Always allow" option).
    const argsJson = (JSON.stringify(event.input ?? {}, null, 2) ?? "{}").slice(0, 2000);
    const message = `${argsJson}\n\nteamclu.always-pattern=${pattern}`;

    const confirmed = await ctx.ui.confirm(title, message);
    if (!confirmed) {
      return { block: true, reason: "Denied by TeamClu permission gate" };
    }
    return undefined;
  });

  // -- MCP bridges (pi has no native MCP) -----------------------------------
  // 1) amuxd remote-tools (single stdio command, its own env contract).
  const cmdRaw = process.env.TEAMCLU_REMOTE_TOOLS_CMD;
  if (cmdRaw) {
    try {
      const cmd = JSON.parse(cmdRaw);
      if (Array.isArray(cmd) && cmd.length > 0 && cmd.every((c) => typeof c === "string")) {
        await bridgeMcpServer(pi, ownTools, "remote-tools", cmd);
      }
    } catch (e) {
      console.error(`[teamclu] invalid TEAMCLU_REMOTE_TOOLS_CMD: ${e}`);
    }
  }

  // 2) The workspace's other MCP servers (from opencode.json `mcp`), bridged so
  //    pi gets the same tools opencode loads natively. Payload:
  //    { "<name>": { "command": [...], "environment": {...} }, ... }
  // Point the config watcher at this session's instance BEFORE bridging, and
  // unconditionally — including when nothing is configured yet. Doing it inside
  // the "has servers" branch below would mean a workspace that starts with no
  // MCP servers never gets a watcher, so adding the first one would still need
  // a pi restart, which is the case this exists to remove.
  WATCH_STATE.target = { pi, ownTools };
  ensureMcpConfigWatcher();

  const serversRaw = process.env.TEAMCLU_MCP_SERVERS;
  if (serversRaw) {
    let servers: Record<string, { command?: unknown; environment?: Record<string, unknown> }>;
    try {
      servers = JSON.parse(serversRaw);
    } catch (e) {
      console.error(`[teamclu] invalid TEAMCLU_MCP_SERVERS: ${e}`);
      servers = {};
    }
    const valid: Record<string, McpServerSpec> = {};
    for (const [name, spec] of Object.entries(servers)) {
      const cmd = spec?.command;
      if (Array.isArray(cmd) && cmd.length > 0 && cmd.every((c) => typeof c === "string")) {
        valid[name] = { command: cmd as string[], environment: spec.environment };
      }
    }
    // Drops servers that are no longer configured before adding the rest (so an
    // edit that replaces one server with another does not leave both running),
    // then spawns in parallel. Only the FIRST session in this process pays a
    // spawn at all — later ones reuse the registry — but that first one used to
    // pay for every server end to end, ~4s each for the npx-based ones.
    await reconcileBridges(pi, ownTools, valid);
  }
}

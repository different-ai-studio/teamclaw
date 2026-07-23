/**
 * TeamClaw pi extension — permission gate + amuxd remote-tools MCP bridge.
 *
 * Shipped inside amuxd (include_str!), materialized to
 * `~/.amuxd/pi/extensions/teamclaw.ts` at pi spawn and loaded via `-e <path>`.
 *
 * ## Env contract (set by amuxd `pi_rpc/process.rs` at spawn)
 *
 * - `TEAMCLAW_PI_PERMISSIONS_FILE` — absolute path to a JSON rules file:
 *       { "defaultAction": "ask" | "allow", "alwaysAllowed": ["ls *", "edit", ...] }
 *   Re-read on every tool call (the daemon appends patterns to it when the
 *   host approves a permission with option_id "always"). Missing or invalid
 *   file ⇒ { defaultAction: "ask", alwaysAllowed: [] }.
 *   Pattern semantics: for `bash` the match key is the command string, for
 *   every other tool it is the tool name. A pattern ending in " *" is a
 *   prefix match on the first word(s); otherwise exact string equality.
 *
 * - `TEAMCLAW_REMOTE_TOOLS_CMD` — JSON array, e.g.
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
 * machine-readable trailer line `teamclaw.always-pattern=<pattern>`; when the
 * host approves with "always", the daemon appends that pattern to the rules
 * file (the dialog reply itself only carries a confirmed boolean).
 */

import * as fs from "node:fs";
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
  const path = process.env.TEAMCLAW_PI_PERMISSIONS_FILE;
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

  constructor(cmd: string[], env?: Record<string, string>) {
    this.child = spawn(cmd[0], cmd.slice(1), {
      stdio: ["pipe", "pipe", "inherit"],
      env: env ? { ...process.env, ...env } : process.env,
    });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => this.onData(chunk));
    this.child.on("exit", () => {
      const err = new Error("remote-tools MCP server exited");
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
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
      this.child.stdin!.write(payload + "\n");
    });
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }) + "\n");
  }
}

// ---------------------------------------------------------------------------
// Team shared LLM provider
// ---------------------------------------------------------------------------

/**
 * Register the team's shared LLM gateway as a pi provider, mirroring how
 * opencode gets `provider.team`. amuxd sets `TEAMCLAW_TEAM_PROVIDER` (from the
 * cloud-resolved managed LLM) to a JSON payload:
 *   { name, baseUrl, apiKeyEnv, models: [{ id, name }] }
 * The secret is never embedded — `apiKeyEnv` names an env var (`tc_api_key`,
 * derived from actor_id, already injected by amuxd) that pi interpolates via
 * `${...}`, the same key opencode uses. Absent/invalid env ⇒ no-op.
 */
function registerTeamProvider(pi: ExtensionAPI): void {
  const raw = process.env.TEAMCLAW_TEAM_PROVIDER;
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
    console.error(`[teamclaw] invalid TEAMCLAW_TEAM_PROVIDER: ${e}`);
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
    console.error(`[teamclaw] registerProvider(team) failed: ${e}`);
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

/** Spawn one stdio MCP server and register each of its tools as a pi tool that
 *  proxies `tools/call`. Best-effort: a failed server never breaks the others. */
async function bridgeMcpServer(
  pi: ExtensionAPI,
  ownTools: Set<string>,
  label: string,
  cmd: string[],
  env?: Record<string, string>,
): Promise<void> {
  try {
    const bridge = new McpBridge(cmd, env);
    await bridge.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "teamclaw-pi-extension", version: "1.0.0" },
    });
    bridge.notify("notifications/initialized");

    const listed = await bridge.request("tools/list");
    const tools: Array<{ name: string; description?: string; inputSchema?: unknown }> =
      listed?.tools ?? [];
    for (const tool of tools) {
      ownTools.add(tool.name);
      pi.registerTool({
        name: tool.name,
        label: tool.name,
        description: tool.description ?? `TeamClaw MCP tool ${tool.name} (${label})`,
        // MCP inputSchema is plain JSON Schema; pi's TypeBox parameters are
        // JSON Schema objects at runtime, so pass it through directly.
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
        async execute(_toolCallId, params) {
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
    console.error(`[teamclaw] MCP bridge unavailable (${label}): ${e}`);
  }
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
    const message = `${argsJson}\n\nteamclaw.always-pattern=${pattern}`;

    const confirmed = await ctx.ui.confirm(title, message);
    if (!confirmed) {
      return { block: true, reason: "Denied by TeamClaw permission gate" };
    }
    return undefined;
  });

  // -- MCP bridges (pi has no native MCP) -----------------------------------
  // 1) amuxd remote-tools (single stdio command, its own env contract).
  const cmdRaw = process.env.TEAMCLAW_REMOTE_TOOLS_CMD;
  if (cmdRaw) {
    try {
      const cmd = JSON.parse(cmdRaw);
      if (Array.isArray(cmd) && cmd.length > 0 && cmd.every((c) => typeof c === "string")) {
        await bridgeMcpServer(pi, ownTools, "remote-tools", cmd);
      }
    } catch (e) {
      console.error(`[teamclaw] invalid TEAMCLAW_REMOTE_TOOLS_CMD: ${e}`);
    }
  }

  // 2) The workspace's other MCP servers (from opencode.json `mcp`), bridged so
  //    pi gets the same tools opencode loads natively. Payload:
  //    { "<name>": { "command": [...], "environment": {...} }, ... }
  const serversRaw = process.env.TEAMCLAW_MCP_SERVERS;
  if (serversRaw) {
    let servers: Record<string, { command?: unknown; environment?: Record<string, unknown> }>;
    try {
      servers = JSON.parse(serversRaw);
    } catch (e) {
      console.error(`[teamclaw] invalid TEAMCLAW_MCP_SERVERS: ${e}`);
      servers = {};
    }
    for (const [name, spec] of Object.entries(servers)) {
      const cmd = spec?.command;
      if (!Array.isArray(cmd) || cmd.length === 0 || cmd.some((c) => typeof c !== "string")) continue;
      await bridgeMcpServer(pi, ownTools, name, cmd as string[], resolveEnv(spec.environment));
    }
  }
}

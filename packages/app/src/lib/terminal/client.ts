import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type TerminalStatus = "running" | "exited";

export interface OpenResult {
  id: string;
  shell: string;
  pid: number;
}

export interface SubscribeResult {
  ring_snapshot: number[];
  cols: number;
  rows: number;
  status: TerminalStatus;
  exit_code: number | null;
}

export interface TerminalSummary {
  id: string;
  shell: string;
  pid: number;
  status: TerminalStatus;
  exit_code: number | null;
}

export interface OpenParams {
  workspaceId: string;
  cwd: string;
  cols: number;
  rows: number;
  shell?: string;
  allowedRoots: string[];
}

export async function openTerminal(p: OpenParams): Promise<OpenResult> {
  return invoke<OpenResult>("terminal_open", {
    workspaceId: p.workspaceId,
    cwd: p.cwd,
    cols: p.cols,
    rows: p.rows,
    shell: p.shell,
    allowedRoots: p.allowedRoots,
  });
}

export async function subscribeTerminal(id: string): Promise<SubscribeResult> {
  return invoke<SubscribeResult>("terminal_subscribe", { id });
}

export async function writeTerminal(id: string, data: Uint8Array): Promise<void> {
  await invoke("terminal_write", { id, data: Array.from(data) });
}

export async function resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
  await invoke("terminal_resize", { id, cols, rows });
}

export async function closeTerminal(id: string): Promise<void> {
  await invoke("terminal_close", { id });
}

export async function listTerminals(workspaceId?: string): Promise<TerminalSummary[]> {
  return invoke<TerminalSummary[]>("terminal_list", { workspaceId });
}

export async function onTerminalData(
  id: string,
  cb: (chunk: Uint8Array) => void,
): Promise<UnlistenFn> {
  return listen<number[]>(`terminal://${id}/data`, e => {
    cb(new Uint8Array(e.payload));
  });
}

export async function onTerminalExit(
  id: string,
  cb: (code: number | null) => void,
): Promise<UnlistenFn> {
  return listen<number | null>(`terminal://${id}/exit`, e => {
    cb(e.payload);
  });
}

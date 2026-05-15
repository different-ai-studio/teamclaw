import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

import {
  onTerminalData,
  onTerminalExit,
  resizeTerminal,
  subscribeTerminal,
  writeTerminal,
} from "@/lib/terminal/client";
import { buildXtermFont, buildXtermTheme } from "@/lib/terminal/theme";
import { useTerminalStore } from "@/stores/terminal-store";

interface Props {
  tabId: string;
  active: boolean;
}

export function XtermInstance({ tabId, active }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const markExited = useTerminalStore(s => s.markExited);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let unlistenData: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let onDataDisposer: { dispose: () => void } | null = null;
    let onResizeDisposer: { dispose: () => void } | null = null;
    let cancelled = false;

    const font = buildXtermFont();
    const term = new Terminal({
      theme: buildXtermTheme(),
      fontFamily: font.fontFamily,
      fontSize: font.fontSize,
      lineHeight: font.lineHeight,
      allowProposedApi: true,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(el);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    (async () => {
      try {
        const { ring_snapshot } = await subscribeTerminal(tabId);
        if (cancelled) return;
        const replayedSnapshotLength = ring_snapshot.length;
        if (ring_snapshot.length > 0) {
          term.write(new Uint8Array(ring_snapshot));
        }

        let bufferingLiveData = true;
        let liveDataBuffer: Uint8Array[] = [];
        unlistenData = await onTerminalData(tabId, chunk => {
          if (bufferingLiveData) {
            liveDataBuffer.push(chunk);
            return;
          }
          term.write(chunk);
        });
        unlistenExit = await onTerminalExit(tabId, code => {
          markExited(tabId, code);
        });
        if (cancelled) return;

        const latest = await subscribeTerminal(tabId);
        if (cancelled) return;
        const catchUpBytes = latest.ring_snapshot.slice(replayedSnapshotLength);
        if (catchUpBytes.length > 0) {
          term.write(new Uint8Array(catchUpBytes));
        }

        const buffered = concatChunks(liveDataBuffer);
        const alreadyCovered = countCoveredPrefix(buffered, catchUpBytes);
        const remainingLiveBytes = buffered.slice(alreadyCovered);
        bufferingLiveData = false;
        liveDataBuffer = [];
        if (remainingLiveBytes.length > 0) {
          term.write(remainingLiveBytes);
        }

        const dims = fit.proposeDimensions();
        if (dims) await resizeTerminal(tabId, dims.cols, dims.rows);

        onDataDisposer = term.onData(d => {
          writeTerminal(tabId, new TextEncoder().encode(d)).catch(() => {});
        });
        onResizeDisposer = term.onResize(({ cols, rows }) => {
          resizeTerminal(tabId, cols, rows).catch(() => {});
        });
      } catch (err) {
        console.warn(`[terminal] subscribe failed for ${tabId}`, err);
      }
    })();

    const onWindowResize = () => fit.fit();
    window.addEventListener("resize", onWindowResize);

    return () => {
      cancelled = true;
      window.removeEventListener("resize", onWindowResize);
      unlistenData?.();
      unlistenExit?.();
      onDataDisposer?.dispose();
      onResizeDisposer?.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [tabId, markExited]);

  useEffect(() => {
    if (active && termRef.current) {
      termRef.current.focus();
      fitRef.current?.fit();
    }
  }, [active]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ display: active ? "block" : "none" }}
    />
  );
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function countCoveredPrefix(buffered: Uint8Array, catchUpBytes: number[]): number {
  const max = Math.min(buffered.length, catchUpBytes.length);
  for (let n = max; n > 0; n -= 1) {
    let matches = true;
    const catchUpStart = catchUpBytes.length - n;
    for (let i = 0; i < n; i += 1) {
      if (buffered[i] !== catchUpBytes[catchUpStart + i]) {
        matches = false;
        break;
      }
    }
    if (matches) return n;
  }
  return 0;
}

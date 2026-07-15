import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
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
import { TerminalSearchOverlay, type SearchController } from "./TerminalSearchOverlay";
import { handleOsc633 } from "@/lib/terminal/osc633";

interface Props {
  tabId: string;
  active: boolean;
}

export function XtermInstance({ tabId, active }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const markExited = useTerminalStore(s => s.markExited);
  const updateCwd = useTerminalStore(s => s.updateCwd);
  const recordCommandStart = useTerminalStore(s => s.recordCommandStart);
  const recordCommandFinish = useTerminalStore(s => s.recordCommandFinish);
  const [searchOpen, setSearchOpen] = useState(false);

  // Stable controller — closes over refs that update across renders.
  const searchController = useMemo<SearchController>(
    () => ({
      findNext: (text, caseSensitive) => {
        searchRef.current?.findNext(text, { caseSensitive });
      },
      findPrevious: (text, caseSensitive) => {
        searchRef.current?.findPrevious(text, { caseSensitive });
      },
      clear: () => {
        termRef.current?.clearSelection();
      },
    }),
    [],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let unlistenData: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let onDataDisposer: { dispose: () => void } | null = null;
    let onResizeDisposer: { dispose: () => void } | null = null;
    let oscDisposer: { dispose: () => void } | null = null;
    let webglAddon: WebglAddon | null = null;
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
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon());
    term.open(el);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    // WebGL renderer — falls back to canvas/DOM if context creation fails or is lost.
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        addon.dispose();
        webglAddon = null;
      });
      term.loadAddon(addon);
      webglAddon = addon;
    } catch (err) {
      console.warn("[terminal] WebGL renderer unavailable, using fallback", err);
    }

    // Intercept Cmd/Ctrl+F before xterm consumes it.
    if (typeof term.attachCustomKeyEventHandler === "function") {
      term.attachCustomKeyEventHandler(e => {
        if (e.type !== "keydown") return true;
        const mod = e.metaKey || e.ctrlKey;
        if (mod && !e.shiftKey && !e.altKey && (e.key === "f" || e.key === "F")) {
          setSearchOpen(true);
          return false;
        }
        return true;
      });
    }

    // OSC 633 — VS Code shell integration. Parses cwd / command start / command exit.
    if (term.parser?.registerOscHandler) {
      oscDisposer = term.parser.registerOscHandler(633, data => {
        handleOsc633(data, {
          onCwd: cwd => updateCwd(tabId, cwd),
          onCommandStart: cmd => recordCommandStart(tabId, cmd),
          onCommandFinish: exit => recordCommandFinish(tabId, exit),
        });
        return true;
      });
    }

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

        // Force WebGL to paint the current viewport. In some WebView builds the
        // first frame after attach is silently dropped — buffer has the prompt
        // but nothing is drawn until a later keystroke/resize triggers refresh.
        term.write("", () => {
          if (cancelled) return;
          term.refresh(0, term.rows - 1);
        });

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
      oscDisposer?.dispose();
      webglAddon?.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, [tabId, markExited, updateCwd, recordCommandStart, recordCommandFinish]);

  useEffect(() => {
    if (active && termRef.current) {
      termRef.current.focus();
      fitRef.current?.fit();
      // Force a repaint when becoming active. Inactive tabs are hidden via
      // the parent's `visibility: hidden`, so their xterm container always
      // has a real size — but WebGL still skips frames while not visible.
      if (typeof termRef.current.refresh === "function") {
        termRef.current.refresh(0, termRef.current.rows - 1);
      }
    }
  }, [active]);

  // Container visibility is owned by the parent (visibility: hidden on
  // inactive tabs). We deliberately do not toggle `display: none` here —
  // `display: none` collapses the container to 0×0, which breaks fit() and
  // leaves the WebGL canvas initialised at zero size for tabs that mount
  // while inactive (e.g. opening a new tab without switching to it first).
  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {searchOpen && (
        <TerminalSearchOverlay
          controller={searchController}
          onClose={() => {
            setSearchOpen(false);
            termRef.current?.focus();
          }}
        />
      )}
    </div>
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

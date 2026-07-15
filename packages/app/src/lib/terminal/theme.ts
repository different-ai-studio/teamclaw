import type { ITheme } from "@xterm/xterm";

function readCssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v.length > 0 ? v : fallback;
}

export function buildXtermTheme(): ITheme {
  return {
    background: readCssVar("--background", "#fbfaf7"),
    foreground: readCssVar("--foreground", "#1a1a14"),
    cursor: readCssVar("--coral", "#e85a4a"),
    cursorAccent: readCssVar("--background", "#fbfaf7"),
    selectionBackground: readCssVar("--selected", "#e7e2d6"),
    // ANSI 0-15 left as xterm defaults so terminal apps' own colors render unchanged.
  };
}

export function buildXtermFont(): { fontFamily: string; fontSize: number; lineHeight: number } {
  const mono = readCssVar("--font-mono", "JetBrains Mono, ui-monospace, Menlo, monospace");
  return { fontFamily: mono, fontSize: 12, lineHeight: 1.4 };
}

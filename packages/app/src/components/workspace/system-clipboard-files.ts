import { isTauri } from '@/lib/utils';

/**
 * Bridge between the file tree's in-app clipboard and the OS pasteboard, so
 * Copy in Finder can be pasted into the tree and vice versa.
 *
 * Everything here degrades to a no-op outside Tauri (browser dev, vitest) and
 * swallows plugin errors: a pasteboard that holds text or an image rather than
 * files is the normal case, not a failure worth surfacing.
 *
 * Finder's "Cut" is deliberately not modelled. macOS has no public cut flag on
 * the pasteboard — Finder implements move-on-paste (⌘⌥V) with a private
 * flavour — so files arriving from outside are always treated as a copy, and
 * an in-app Cut pasted into Finder lands as a copy with the original intact.
 */

async function api() {
  return import('tauri-plugin-clipboard-api');
}

/**
 * Whether the OS pasteboard holds files, without reading their paths.
 * Used to enable the Paste affordance — checking the available types is
 * cheaper than pulling content, and avoids touching the actual clipboard
 * payload on every window focus.
 */
export async function hasSystemClipboardFiles(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { hasFiles } = await api();
    return await hasFiles();
  } catch (error) {
    console.warn('[FileTree] Failed to inspect clipboard:', error);
    return false;
  }
}

/** Absolute paths currently on the OS pasteboard. Empty when it holds no files. */
export async function readSystemClipboardFiles(): Promise<string[]> {
  if (!isTauri()) return [];
  try {
    const { hasFiles, readFiles } = await api();
    if (!(await hasFiles())) return [];
    const paths = await readFiles();
    return paths.filter((p) => typeof p === 'string' && p.length > 0);
  } catch (error) {
    console.warn('[FileTree] Failed to read clipboard files:', error);
    return [];
  }
}

/**
 * Publish paths to the OS pasteboard so Finder can paste them.
 * Failure is non-fatal — the in-app clipboard still works on its own.
 */
export async function writeSystemClipboardFiles(paths: string[]): Promise<void> {
  if (!isTauri() || paths.length === 0) return;
  try {
    const { writeFiles } = await api();
    await writeFiles(paths);
  } catch (error) {
    console.warn('[FileTree] Failed to write clipboard files:', error);
  }
}

/**
 * Decide what a paste should act on, given what the OS pasteboard holds and
 * what the in-app clipboard remembers.
 *
 * The in-app `cut` mode only survives if the pasteboard still holds exactly the
 * paths we put there. Once the user copies something else — in Finder or in
 * another app — that pending move is stale, and honouring it would move files
 * the user never selected.
 */
export function resolvePasteSource(
  systemPaths: string[],
  internalPaths: string[],
  internalMode: 'copy' | 'cut' | null,
): { paths: string[]; mode: 'copy' | 'cut' } | null {
  if (systemPaths.length > 0) {
    const sameAsInternal =
      internalPaths.length === systemPaths.length &&
      internalPaths.every((p) => systemPaths.includes(p));
    return {
      paths: systemPaths,
      mode: sameAsInternal && internalMode ? internalMode : 'copy',
    };
  }
  if (internalPaths.length > 0 && internalMode) {
    return { paths: internalPaths, mode: internalMode };
  }
  return null;
}

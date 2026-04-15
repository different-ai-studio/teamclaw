import { isTauri } from '@/lib/utils';
import { TEAM_REPO_DIR } from '@/lib/build-config';

// File operation helpers
export async function createNewFile(
  dirPath: string,
  fileName: string,
): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const fullPath = `${dirPath}/${fileName}`;
    await writeTextFile(fullPath, "");
    return true;
  } catch (error) {
    console.error("[FileTree] Failed to create file:", error);
    return false;
  }
}

export async function createNewFolder(
  dirPath: string,
  folderName: string,
): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { mkdir } = await import("@tauri-apps/plugin-fs");
    const fullPath = `${dirPath}/${folderName}`;
    await mkdir(fullPath);
    return true;
  } catch (error) {
    console.error("[FileTree] Failed to create folder:", error);
    return false;
  }
}

export async function renameItem(oldPath: string, newPath: string): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { rename } = await import("@tauri-apps/plugin-fs");
    await rename(oldPath, newPath);
    return true;
  } catch (error) {
    console.error("[FileTree] Failed to rename:", error);
    return false;
  }
}

/**
 * Map of synced DocType directory names to their CRDT doc type identifiers.
 */
const SYNCED_DIR_TO_DOCTYPE: Record<string, string> = {
  'skills': 'skills',
  '.mcp': 'mcp',
  'knowledge': 'knowledge',
  '_meta': 'meta',
  '_secrets': 'secrets',
};

/**
 * If `absolutePath` is inside a team-synced DocType directory, mark the file
 * as deleted in the CRDT so other nodes don't resurrect it.
 * Best-effort: failures are silently ignored — the sync loop will eventually
 * detect the deletion on disk.
 */
export async function markTeamFileDeleted(
  absolutePath: string,
  workspacePath?: string,
): Promise<void> {
  if (!isTauri() || !workspacePath) return;
  const teamDir = `${workspacePath}/${TEAM_REPO_DIR}`;
  if (!absolutePath.startsWith(teamDir + '/')) return;

  const relToTeam = absolutePath.slice(teamDir.length + 1); // e.g. "skills/my-skill"
  const firstSeg = relToTeam.split('/')[0];               // e.g. "skills"
  const docType = SYNCED_DIR_TO_DOCTYPE[firstSeg];
  if (!docType) return;

  const relPath = relToTeam.slice(firstSeg.length + 1);    // e.g. "my-skill"
  if (!relPath) return;

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke('oss_mark_file_deleted', { docType, path: relPath });
  } catch {
    // best-effort
  }
}

export async function deleteItem(
  path: string,
  isDirectory: boolean,
  workspacePath?: string,
): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { remove } = await import("@tauri-apps/plugin-fs");
    await remove(path, { recursive: isDirectory });
    // Mark in CRDT if this was a team-synced file
    markTeamFileDeleted(path, workspacePath);
    return true;
  } catch (error) {
    console.error("[FileTree] Failed to delete:", error);
    return false;
  }
}

export async function revealInFinder(path: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("show_in_folder", { path });
  } catch {
    // Fallback: try shell open on the parent directory
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      const parentDir = path.substring(0, path.lastIndexOf("/"));
      await open(parentDir);
    } catch (error) {
      console.error("[FileTree] Failed to reveal in finder:", error);
    }
  }
}

export async function openWithDefaultApp(path: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_with_default_app", { path });
  } catch (error) {
    console.error("[FileTree] Failed to open with default app:", error);
  }
}

export async function openInTerminal(dirPath: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_in_terminal", { path: dirPath });
  } catch (error) {
    console.error("[FileTree] Failed to open terminal:", error);
  }
}

export async function moveItem(fromPath: string, toDir: string): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { rename } = await import("@tauri-apps/plugin-fs");
    const fileName = fromPath.substring(fromPath.lastIndexOf("/") + 1);
    const newPath = `${toDir}/${fileName}`;
    if (fromPath === newPath) return false;
    await rename(fromPath, newPath);
    return true;
  } catch (error) {
    console.error("[FileTree] Failed to move item:", error);
    return false;
  }
}

/** Recursively copy a file or directory to a target directory */
export async function copyItem(sourcePath: string, targetDir: string): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { exists, readDir, readFile, writeFile, mkdir } = await import("@tauri-apps/plugin-fs");
    const name = sourcePath.substring(sourcePath.lastIndexOf("/") + 1);
    let destPath = `${targetDir}/${name}`;

    // Handle naming conflict: append " copy" or " copy N"
    if (await exists(destPath)) {
      const ext = name.includes('.') ? '.' + name.split('.').pop() : '';
      const base = ext ? name.slice(0, -ext.length) : name;
      let suffix = 1;
      destPath = `${targetDir}/${base} copy${ext}`;
      while (await exists(destPath)) {
        suffix++;
        destPath = `${targetDir}/${base} copy ${suffix}${ext}`;
      }
    }

    // Check if source is a directory
    try {
      const entries = await readDir(sourcePath);
      // It's a directory — create it and copy contents recursively
      await mkdir(destPath);
      for (const entry of entries) {
        const childPath = `${sourcePath}/${entry.name}`;
        const success = await copyItem(childPath, destPath);
        if (!success) return false;
      }
      return true;
    } catch {
      // Not a directory — it's a file, copy bytes
      const bytes = await readFile(sourcePath);
      await writeFile(destPath, bytes);
      return true;
    }
  } catch (error) {
    console.error("[FileTree] Failed to copy item:", error);
    return false;
  }
}

/** Copy files from external paths (e.g. Finder drag-drop) into a target directory */
export async function copyExternalFiles(sourcePaths: string[], targetDir: string): Promise<boolean> {
  if (!isTauri() || sourcePaths.length === 0) return false;
  try {
    let allSuccess = true;
    for (const sourcePath of sourcePaths) {
      const success = await copyItem(sourcePath, targetDir);
      if (!success) allSuccess = false;
    }
    return allSuccess;
  } catch (error) {
    console.error("[FileTree] Failed to copy external files:", error);
    return false;
  }
}

/** Duplicate a file or folder in the same directory (appends " copy" / " copy N") */
export async function duplicateItem(sourcePath: string): Promise<boolean> {
  if (!isTauri()) return false;
  const parentDir = sourcePath.substring(0, sourcePath.lastIndexOf("/"));
  return copyItem(sourcePath, parentDir);
}

function isFsScopeError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('forbidden path:');
}

/** Read file content for undo backup (text files only) */
export async function readFileContent(
  workspacePath: string,
  path: string,
): Promise<string | undefined> {
  if (!isTauri()) return undefined;
  try {
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    return await readTextFile(path);
  } catch (error) {
    if (!isFsScopeError(error)) {
      return undefined; // Binary or unreadable
    }

    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<string>("read_workspace_text_file", { workspacePath, path });
    } catch {
      return undefined;
    }
  }
}

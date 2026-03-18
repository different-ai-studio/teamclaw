import { isTauri } from '@/lib/utils';

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

export async function deleteItem(
  path: string,
  isDirectory: boolean,
): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { remove } = await import("@tauri-apps/plugin-fs");
    await remove(path, { recursive: isDirectory });
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

/** Read file content for undo backup (text files only) */
export async function readFileContent(path: string): Promise<string | undefined> {
  if (!isTauri()) return undefined;
  try {
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    return await readTextFile(path);
  } catch {
    return undefined; // Binary or unreadable
  }
}

/** Extract the filename from an absolute path */
export function getFileName(filePath: string): string {
  const sep = filePath.includes("\\") ? "\\" : "/";
  return filePath.split(sep).pop() || filePath;
}

/** Returns "parentDir/filename" for display, falling back to just filename */
export function getFileDisplayPath(filePath: string): string {
  const sep = filePath.includes("\\") ? "\\" : "/";
  const parts = filePath.split(sep).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }
  return parts[parts.length - 1] || filePath;
}

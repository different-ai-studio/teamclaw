/**
 * Image paste handler for Markdown editor.
 * Handles clipboard image detection, _assets directory creation,
 * unique filename generation, image file upload, and path resolution.
 */

import { nanoid } from 'nanoid';
import { isTauri } from '@/lib/utils'


/**
 * Get the directory of a file path.
 */
function getFileDir(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash >= 0 ? normalized.substring(0, lastSlash) : '.';
}

/**
 * Convert a relative image path (e.g. `_assets/img.png`) to an absolute URL
 * that the Tauri webview can load.
 */
export async function resolveImageSrc(relativeSrc: string, markdownFilePath: string): Promise<string> {
  if (!isTauri()) return relativeSrc;
  // Already an absolute URL or data URL
  if (relativeSrc.startsWith('http') || relativeSrc.startsWith('data:') || relativeSrc.startsWith('asset:')) {
    return relativeSrc;
  }

  try {
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    const dir = getFileDir(markdownFilePath);
    const absolutePath = `${dir}/${relativeSrc}`;
    return convertFileSrc(absolutePath);
  } catch {
    return relativeSrc;
  }
}

/**
 * Pre-process markdown content: replace relative image paths with absolute Tauri asset URLs
 * so that images render inline in the editor.
 */
export async function resolveMarkdownImages(markdown: string, markdownFilePath: string): Promise<string> {
  if (!isTauri() || !markdown) return markdown;

  // Match markdown image syntax: ![alt](src)
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const matches = [...markdown.matchAll(imageRegex)];
  if (matches.length === 0) return markdown;

  let result = markdown;
  for (const match of matches) {
    const [fullMatch, alt, src] = match;
    // Only resolve relative paths (not http/https/data URLs)
    if (!src.startsWith('http') && !src.startsWith('data:') && !src.startsWith('asset:')) {
      const resolvedSrc = await resolveImageSrc(src, markdownFilePath);
      result = result.replace(fullMatch, `![${alt}](${resolvedSrc})`);
    }
  }

  return result;
}

/**
 * Post-process markdown content: convert absolute Tauri asset URLs back to relative paths
 * for storage.
 */
export function unresolveMarkdownImages(markdown: string, markdownFilePath: string): string {
  if (!markdown) return markdown;

  const dir = getFileDir(markdownFilePath);

  // Match asset:// or https://asset.localhost URLs in image syntax
  // convertFileSrc produces URLs like: https://asset.localhost/path or asset://localhost/path
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;

  return markdown.replace(imageRegex, (_fullMatch, alt, src) => {
    // Try to extract the original file path from the asset URL
    let filePath: string | null = null;

    // Format: https://asset.localhost/ABSOLUTE_PATH
    if (src.includes('asset.localhost/')) {
      filePath = decodeURIComponent(src.split('asset.localhost')[1]);
    }
    // Format: asset://localhost/ABSOLUTE_PATH
    else if (src.startsWith('asset://')) {
      filePath = decodeURIComponent(src.replace('asset://localhost', ''));
    }

    if (filePath) {
      // Convert back to relative path from the markdown file's directory
      const normalizedDir = dir.replace(/\\/g, '/');
      const normalizedFile = filePath.replace(/\\/g, '/');
      if (normalizedFile.startsWith(normalizedDir + '/')) {
        const relativePath = normalizedFile.slice(normalizedDir.length + 1);
        return `![${alt}](${relativePath})`;
      }
    }

    // Return as-is if we can't resolve
    return `![${alt}](${src})`;
  });
}

/** Supported image MIME types and their file extensions */
const IMAGE_MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * Detect image data in clipboard event.
 * Returns the first image File found, or null.
 */
export function detectClipboardImage(event: ClipboardEvent): File | null {
  const items = event.clipboardData?.items;
  if (!items) return null;

  for (const item of items) {
    if (item.kind === 'file' && IMAGE_MIME_TO_EXT[item.type]) {
      return item.getAsFile();
    }
  }
  return null;
}

/**
 * Generate a unique filename for an uploaded image.
 * Format: YYYYMMDD-HHMMSS-{nanoid}.{ext}
 */
export function generateImageFilename(mimeType: string): string {
  const ext = IMAGE_MIME_TO_EXT[mimeType] || 'png';
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  const id = nanoid(8);
  return `${timestamp}-${id}.${ext}`;
}

/**
 * Get the _assets directory path for a given file path.
 * The _assets directory is at the same level as the markdown file.
 */
export function getAssetsDir(filePath: string): string {
  // Use forward slashes for path manipulation, convert back if needed
  const normalized = filePath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  const dir = lastSlash >= 0 ? normalized.substring(0, lastSlash) : '.';
  return `${dir}/_assets`;
}

/**
 * Save an image file to the _assets directory and return the relative markdown reference.
 * Returns the markdown image syntax string on success, or null on failure.
 */
type ImageSaveResult =
  | { markdownSyntax: string; absolutePath: string; error?: string }
  | { markdownSyntax?: undefined; absolutePath?: undefined; error: string };

export async function saveClipboardImage(
  imageFile: File,
  filePath: string,
): Promise<ImageSaveResult> {
  if (!isTauri()) {
    return { error: 'Image paste is only supported in Tauri environment' };
  }

  try {
    const { mkdir, writeFile } = await import('@tauri-apps/plugin-fs');

    const assetsDir = getAssetsDir(filePath);
    const filename = generateImageFilename(imageFile.type);
    const imagePath = `${assetsDir}/${filename}`;

    // Create _assets directory if it doesn't exist
    try {
      await mkdir(assetsDir, { recursive: true });
    } catch {
      // Directory may already exist, ignore error
    }

    // Read image file as ArrayBuffer and write to disk
    const buffer = await imageFile.arrayBuffer();
    await writeFile(imagePath, new Uint8Array(buffer));

    // Return markdown syntax with relative path and absolute path for display
    const markdownSyntax = `![](${`_assets/${filename}`})`;
    return { markdownSyntax, absolutePath: imagePath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to save image: ${message}` };
  }
}

/** Extension to MIME type mapping */
const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * Upload an image from a local file path (selected via Tauri dialog) to the _assets directory.
 * Copies the file and returns the markdown reference.
 */
export async function uploadImageFromPath(
  sourcePath: string,
  markdownFilePath: string,
): Promise<ImageSaveResult> {
  if (!isTauri()) {
    return { error: 'Image upload is only supported in Tauri environment' };
  }

  try {
    const { mkdir, readFile, writeFile } = await import('@tauri-apps/plugin-fs');

    // Determine file extension and MIME type from source path
    const ext = sourcePath.split('.').pop()?.toLowerCase() || 'png';
    const mimeType = EXT_TO_MIME[ext] || 'image/png';

    const assetsDir = getAssetsDir(markdownFilePath);
    const filename = generateImageFilename(mimeType);
    const destPath = `${assetsDir}/${filename}`;

    // Create _assets directory if it doesn't exist
    try {
      await mkdir(assetsDir, { recursive: true });
    } catch {
      // Directory may already exist, ignore error
    }

    // Read the source image and copy to _assets
    const imageData = await readFile(sourcePath);
    await writeFile(destPath, imageData);

    const markdownSyntax = `![](${`_assets/${filename}`})`;
    return { markdownSyntax, absolutePath: destPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to upload image: ${message}` };
  }
}

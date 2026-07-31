const IMAGE_PATH_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|heic|heif)$/i;

function isImagePath(path: string): boolean {
  return IMAGE_PATH_RE.test(path);
}

/**
 * Strip pasted `[Attachment: name](path: …)` tokens that point at images and
 * return those paths so the composer can promote them into image previews.
 */
export function extractImageAttachmentTokens(text: string): {
  cleaned: string;
  imagePaths: string[];
} {
  const attachmentPattern = /\[Attachment:\s*([^\]]+)\]\s*\(([^)]*)\)/gi;
  const imagePaths: string[] = [];

  let cleaned = text.replace(attachmentPattern, (full, _name, info) => {
    const pathMatch = String(info).match(/path:\s*([^,)]+)/i);
    const fullPath = pathMatch ? pathMatch[1].trim() : "";
    if (fullPath && isImagePath(fullPath)) {
      imagePaths.push(fullPath);
      return "";
    }
    return full;
  });

  const filteredLines = cleaned.split("\n").filter((line) => {
    if (!line.includes("[Attachment:")) return true;
    const pathMatch = line.match(/path:\s*([^)]+)\)?/i);
    const maybePath = pathMatch ? pathMatch[1].trim() : "";
    if (maybePath && isImagePath(maybePath)) return false;
    return true;
  });

  cleaned = filteredLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/ {2,}/g, " ")
    .trimStart();

  return { cleaned, imagePaths };
}

import { useTranslation } from "react-i18next";
import {
  FileArchive,
  FileVideo,
  FileAudio,
  FileType2,
  HardDrive,
  Package,
  ExternalLink,
  File,
} from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Known binary file extensions that cannot be previewed as text.
 * Used both in the store (to skip reading) and in the viewer (to detect type).
 */
export const UNSUPPORTED_BINARY_EXTENSIONS = new Set([
  // Archives
  "zip",
  "rar",
  "7z",
  "tar",
  "gz",
  "bz2",
  "xz",
  "zst",
  "tgz",
  "lz",
  "lzma",
  // Executables & installers
  "exe",
  "dmg",
  "app",
  "msi",
  "deb",
  "rpm",
  "appimage",
  // Office documents
  "docx",
  "xlsx",
  "pptx",
  "doc",
  "xls",
  "ppt",
  "odt",
  "ods",
  "odp",
  "rtf",
  // Video
  "mp4",
  "avi",
  "mov",
  "wmv",
  "flv",
  "mkv",
  "webm",
  "m4v",
  "3gp",
  // Audio
  "mp3",
  "wav",
  "ogg",
  "flac",
  "aac",
  "m4a",
  "wma",
  "opus",
  // Fonts
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  // Database
  "sqlite",
  "db",
  "mdb",
  // Compiled / object
  "o",
  "so",
  "dylib",
  "dll",
  "class",
  "pyc",
  "pyo",
  "wasm",
  // Disk images & misc binary
  "bin",
  "dat",
  "iso",
  "img",
  // Design / media
  "psd",
  "ai",
  "sketch",
  "fig",
  "xd",
]);

type FileCategory =
  | "archive"
  | "video"
  | "audio"
  | "document"
  | "executable"
  | "font"
  | "database"
  | "compiled"
  | "design"
  | "other";

function getFileCategory(ext: string): FileCategory {
  if (
    ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "tgz", "lz", "lzma"].includes(
      ext,
    )
  )
    return "archive";
  if (
    ["mp4", "avi", "mov", "wmv", "flv", "mkv", "webm", "m4v", "3gp"].includes(
      ext,
    )
  )
    return "video";
  if (
    ["mp3", "wav", "ogg", "flac", "aac", "m4a", "wma", "opus"].includes(ext)
  )
    return "audio";
  if (
    [
      "docx",
      "xlsx",
      "pptx",
      "doc",
      "xls",
      "ppt",
      "odt",
      "ods",
      "odp",
      "rtf",
    ].includes(ext)
  )
    return "document";
  if (
    ["exe", "dmg", "app", "msi", "deb", "rpm", "appimage"].includes(ext)
  )
    return "executable";
  if (["woff", "woff2", "ttf", "otf", "eot"].includes(ext)) return "font";
  if (["sqlite", "db", "mdb"].includes(ext)) return "database";
  if (
    ["o", "so", "dylib", "dll", "class", "pyc", "pyo", "wasm"].includes(ext)
  )
    return "compiled";
  if (["psd", "ai", "sketch", "fig", "xd"].includes(ext)) return "design";
  return "other";
}

function getCategoryIcon(category: FileCategory) {
  switch (category) {
    case "archive":
      return FileArchive;
    case "video":
      return FileVideo;
    case "audio":
      return FileAudio;
    case "document":
      return FileType2;
    case "executable":
      return Package;
    case "font":
      return FileType2;
    case "database":
      return HardDrive;
    case "compiled":
      return Package;
    case "design":
      return FileType2;
    default:
      return File;
  }
}

interface UnsupportedFileViewerProps {
  filename: string;
  filePath: string;
  onClose?: () => void;
}

export default function UnsupportedFileViewer({
  filename,
  filePath,
}: UnsupportedFileViewerProps) {
  const { t } = useTranslation();

  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const category = getFileCategory(ext);
  const CategoryIcon = getCategoryIcon(category);

  const categoryLabels: Record<FileCategory, string> = {
    archive: t("app.fileCategory.archive", "Archive"),
    video: t("app.fileCategory.video", "Video"),
    audio: t("app.fileCategory.audio", "Audio"),
    document: t("app.fileCategory.document", "Document"),
    executable: t("app.fileCategory.executable", "Executable"),
    font: t("app.fileCategory.font", "Font"),
    database: t("app.fileCategory.database", "Database"),
    compiled: t("app.fileCategory.compiled", "Compiled file"),
    design: t("app.fileCategory.design", "Design file"),
    other: t("app.fileCategory.other", "Binary file"),
  };

  const handleOpenExternal = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(filePath);
    } catch (err) {
      console.error("[UnsupportedFileViewer] Failed to open externally:", err);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center h-10 px-3 border-b bg-muted/30 shrink-0 gap-3">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <CategoryIcon className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground truncate">{filePath}</span>
        </div>
      </div>

      {/* Content - unsupported file message */}
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 max-w-sm text-center px-6">
          {/* Large icon */}
          <div className="w-20 h-20 rounded-2xl bg-muted/50 flex items-center justify-center">
            <CategoryIcon className="h-10 w-10 text-muted-foreground/60" />
          </div>

          {/* File info */}
          <div className="space-y-1.5">
            <h3 className="text-sm font-medium text-foreground">{filename}</h3>
            <div className="flex items-center justify-center gap-2">
              <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground uppercase font-mono">
                .{ext}
              </span>
              <span className="text-xs text-muted-foreground">
                {categoryLabels[category]}
              </span>
            </div>
          </div>

          {/* Message */}
          <p className="text-sm text-muted-foreground">
            {t(
              "app.unsupportedFileFormat",
              "This file format cannot be previewed. You can open it with an external application.",
            )}
          </p>

          {/* Action button */}
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={handleOpenExternal}
          >
            <ExternalLink className="h-4 w-4" />
            {t("app.openWithExternalApp", "Open with default app")}
          </Button>
        </div>
      </div>
    </div>
  );
}

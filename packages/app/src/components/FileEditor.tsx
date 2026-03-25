import {
  useEffect,
  useState,
  useCallback,
  useRef,
  useMemo,
  lazy,
  Suspense,
} from "react";
import { useTranslation } from "react-i18next";
import {
  FileText,
  Loader2,
  Save,
  GitCompare,
  Code,
  Image,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Files,
  Eye,
} from "lucide-react";
import { cn, isTauri } from "@/lib/utils";
import { TEAM_REPO_DIR } from "@/lib/build-config";
import { getEditorType } from "@/components/editors/utils";
import { UNSUPPORTED_BINARY_EXTENSIONS } from "@/components/viewers/UnsupportedFileViewer";
import { supportsPreview } from "@/components/editors/utils";
import { useAutoSave } from "@/components/editors/useAutoSave";
import { ConflictBanner } from "@/components/editors/ConflictBanner";
import { useSessionStore } from "@/stores/session";
import { useUIStore } from "@/stores/ui";
import { useWorkspaceStore } from "@/stores/workspace";
import { useTeamModeStore } from "@/stores/team-mode";
import { useGitStatus } from "@/hooks/use-git-status";
import { gitManager } from "@/lib/git/manager";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// Editors - lazy loaded per file type
const LazyTiptapMarkdownEditor = lazy(
  () => import("@/components/editors/TiptapMarkdownEditor"),
);
const LazyCodeEditor = lazy(() => import("@/components/editors/CodeEditor"));
const LazyDiffRenderer = lazy(() => import("@/components/diff/DiffRenderer"));

// Viewers - lazy loaded
const LazyPDFViewer = lazy(
  () => import("@/components/viewers/PDFViewer"),
);
const LazyUnsupportedFileViewer = lazy(
  () => import("@/components/viewers/UnsupportedFileViewer"),
);

// Helper to detect file type
export function getFileType(
  filename: string,
): "image" | "pdf" | "binary" | "text" {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const imageExtensions = [
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "bmp",
    "ico",
    "svg",
  ];
  if (imageExtensions.includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (UNSUPPORTED_BINARY_EXTENSIONS.has(ext)) return "binary";
  return "text";
}

// Image Viewer component
export function ImageViewer({
  content,
  filename,
  filePath,
}: {
  content: string;
  filename: string;
  filePath: string;
}) {
  const { t } = useTranslation();
  const [zoom, setZoom] = useState(100);
  const [rotation, setRotation] = useState(0);

  const handleZoomIn = () => setZoom((prev) => Math.min(prev + 25, 300));
  const handleZoomOut = () => setZoom((prev) => Math.max(prev - 25, 25));
  const handleRotate = () => setRotation((prev) => (prev + 90) % 360);
  const handleReset = () => {
    setZoom(100);
    setRotation(0);
  };

  return (
    <div className="flex flex-col h-full" data-testid="file-editor">
      {/* Header - simple and clean */}
      <div className="flex items-center h-10 px-3 border-b bg-muted/30 shrink-0 gap-3">
        {/* Full file path */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Image className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground truncate">{filePath}</span>
        </div>

        {/* Zoom controls */}
        <div className="flex items-center gap-1 ml-auto">
          <button
            className="p-1.5 rounded hover:bg-muted text-muted-foreground"
            onClick={handleZoomOut}
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <span className="text-xs text-muted-foreground w-10 text-center">
            {zoom}%
          </span>
          <button
            className="p-1.5 rounded hover:bg-muted text-muted-foreground"
            onClick={handleZoomIn}
          >
            <ZoomIn className="h-4 w-4" />
          </button>
          <button
            className="p-1.5 rounded hover:bg-muted text-muted-foreground"
            onClick={handleRotate}
          >
            <RotateCw className="h-4 w-4" />
          </button>
          <button
            className="px-2 py-1 rounded hover:bg-muted text-xs text-muted-foreground"
            onClick={handleReset}
          >
            {t("app.reset", "Reset")}
          </button>
        </div>
      </div>

      {/* Image container */}
      <div className="flex-1 overflow-auto bg-muted/20 flex items-center justify-center p-4">
        <img
          src={content}
          alt={filename}
          className="max-w-full max-h-full object-contain transition-transform duration-200"
          style={{
            transform: `scale(${zoom / 100}) rotate(${rotation}deg)`,
          }}
        />
      </div>
    </div>
  );
}

// File Content Viewer for File Mode - shows file editor or empty state
export function FileContentViewer({
  selectedFile,
  fileContent,
  isLoadingFile,
  onClose,
}: {
  selectedFile: string | null;
  fileContent: string | null;
  isLoadingFile: boolean;
  onClose: () => void;
}) {
  const reloadSelectedFile = useWorkspaceStore((s) => s.reloadSelectedFile);
  const { t } = useTranslation();
  const filename = selectedFile?.split("/").pop() || "";
  const fileType = getFileType(filename);
  const isFileOpen = !!selectedFile;

  // Listen for file changes and reload when the current file is modified
  useEffect(() => {
    if (!isTauri() || !selectedFile) return;

    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");

        unlisten = await listen<{ path: string; kind: string }>(
          "file-change",
          (event) => {
            const changedPath = event.payload.path;

            // Check if the changed file matches our selected file
            // Normalize paths for comparison
            const normalizedSelected = selectedFile.replace(/^\/+|\/+$/g, "");
            const normalizedChanged = changedPath.replace(/^\/+|\/+$/g, "");

            if (
              normalizedSelected === normalizedChanged ||
              normalizedSelected.endsWith("/" + normalizedChanged) ||
              normalizedChanged.endsWith("/" + normalizedSelected)
            ) {
              console.log(
                "[FileContentViewer] Current file changed, reloading:",
                selectedFile,
              );
              reloadSelectedFile();
            }
          },
        );
      } catch (error) {
        console.error(
          "[FileContentViewer] Failed to setup file change listener:",
          error,
        );
      }
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [selectedFile, reloadSelectedFile]);

  if (!isFileOpen) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <Files className="h-16 w-16 mb-4 opacity-30" />
        <p className="text-sm">
          {t("app.selectFile", "Select a file from the explorer")}
        </p>
        <p className="text-xs text-muted-foreground/60 mt-1">
          {t("app.clickFileToView", "Click on a file to view its contents")}
        </p>
      </div>
    );
  }

  if (isLoadingFile) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (fileContent === null) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <FileText className="h-12 w-12 mb-3 opacity-50" />
        <p className="text-sm">
          {t("app.unableToLoadFile", "Unable to load file content")}
        </p>
        <Button variant="ghost" size="sm" onClick={onClose} className="mt-2">
          {t("common.close", "Close")}
        </Button>
      </div>
    );
  }

  // Render appropriate viewer based on file type
  if (fileType === "image") {
    return (
      <ImageViewer
        content={fileContent}
        filename={filename}
        filePath={selectedFile!}
      />
    );
  }

  if (fileType === "pdf") {
    return (
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        }
      >
        <LazyPDFViewer
          content={fileContent}
          filename={filename}
          filePath={selectedFile!}
        />
      </Suspense>
    );
  }

  if (fileType === "binary") {
    return (
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        }
      >
        <LazyUnsupportedFileViewer
          filename={filename}
          filePath={selectedFile!}
        />
      </Suspense>
    );
  }

  return (
    <FileEditor
      content={fileContent}
      filename={filename}
      filePath={selectedFile}
      onClose={onClose}
    />
  );
}

// File Editor component - routes to appropriate editor based on file type
export function FileEditor({
  content,
  filename,
  filePath,
  onClose,
}: {
  content: string;
  filename: string;
  filePath: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const myRole = useTeamModeStore((s) => s.myRole)
  const isTeamFile = filePath?.includes(`/${TEAM_REPO_DIR}/`) ?? false
  const isViewerReadOnly = isTeamFile && myRole === 'viewer'
  const targetLine = useWorkspaceStore((s) => s.targetLine);
  const targetHeading = useWorkspaceStore((s) => s.targetHeading);
  const [currentContent, setCurrentContent] = useState(content);
  const [isModified, setIsModified] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [showPreview, setShowPreview] = useState(supportsPreview(filename) === "html");
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [externalUpdateType, setExternalUpdateType] = useState<
    "updated" | "changed_externally" | null
  >(null);
  const previousContentRef = useRef(content);

  // --- Markdown auto-save & conflict state ---
  const isMarkdown = getEditorType(filename) === "markdown";
  const tiptapEditorRef = useRef<import("@/components/editors/TiptapMarkdownEditor").TiptapEditorHandle>(null);

  // Conflict state for markdown files
  const [conflictAgentContent, setConflictAgentContent] = useState<string | null>(null);
  const [showConflictDiff, setShowConflictDiff] = useState(false);

  // Auto-save hook (only active for markdown files)
  const { saveStatus, isSelfWrite, saveNow, cancelPendingSave } = useAutoSave({
    filePath,
    content: currentContent,
    isModified: isMarkdown ? isModified : false,
    enabled: isMarkdown,
  });

  // Git status integration (hook called for side effects)
  useGitStatus();

  // Git HEAD content for git gutter decorations
  const [gitHeadContent, setGitHeadContent] = useState<string | null>(null);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  // Fetch the file's content from git HEAD for gutter decorations
  useEffect(() => {
    if (!isTauri() || !workspacePath || !filePath) return;

    let cancelled = false;

    (async () => {
      try {
        // Compute relative path within workspace
        const normalizedWorkspace = workspacePath.replace(/\/+$/, "");
        const normalizedFile = filePath.replace(/\/+$/, "");
        let relativePath = normalizedFile;
        if (normalizedFile.startsWith(normalizedWorkspace + "/")) {
          relativePath = normalizedFile.slice(normalizedWorkspace.length + 1);
        }

        const headContent = await gitManager.showFile(
          normalizedWorkspace,
          relativePath,
        );
        if (!cancelled) {
          setGitHeadContent(headContent);
        }
      } catch {
        // Not a git repo, file not tracked, etc.
        if (!cancelled) {
          setGitHeadContent(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workspacePath, filePath]);

  // Check if this file supports preview
  const previewType = supportsPreview(filename);

  // Get session diff to check if this file has changes - precise selector
  const sessionDiff = useSessionStore((s) => s.sessionDiff);

  // Find if this file has changes in the current session
  const fileDiff = useMemo(() => {
    // Normalize the file path for comparison
    const normalizedPath = filePath.replace(/^\/+|\/+$/g, "");

    return sessionDiff.find((diff) => {
      const normalizedDiffPath = diff.file.replace(/^\/+|\/+$/g, "");
      // Check various path matching scenarios
      return (
        normalizedPath === normalizedDiffPath ||
        normalizedPath.endsWith("/" + normalizedDiffPath) ||
        normalizedPath.endsWith(normalizedDiffPath) ||
        normalizedDiffPath.endsWith("/" + normalizedPath) ||
        normalizedDiffPath.endsWith(normalizedPath)
      );
    });
  }, [filePath, sessionDiff]);

  // Determine if file has any kind of changes (session diff OR git diff)
  const hasSessionChanges = !!fileDiff;
  const hasGitChanges = gitHeadContent !== null && gitHeadContent !== content;
  const hasChanges = hasSessionChanges || hasGitChanges;

  // Compute git-level +/- stats when no session diff is available
  const gitDiffStats = useMemo(() => {
    if (hasSessionChanges || !gitHeadContent) return null;
    const oldLines = gitHeadContent.split("\n");
    const newLines = content.split("\n");
    // Simple line count diff
    let additions = 0;
    let deletions = 0;
    const maxLen = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < maxLen; i++) {
      if (i >= oldLines.length) {
        additions++;
        continue;
      }
      if (i >= newLines.length) {
        deletions++;
        continue;
      }
      if (oldLines[i] !== newLines[i]) {
        additions++;
        deletions++;
      }
    }
    return { additions, deletions };
  }, [hasSessionChanges, gitHeadContent, content]);

  // Auto-show diff view when session has changes
  useEffect(() => {
    if (hasSessionChanges) {
      setShowDiff(true);
    }
  }, [hasSessionChanges]);

  // Detect dark mode
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );

  // Watch for theme changes
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains("dark"));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  // Handle external content changes (e.g., file modified by agent)
  useEffect(() => {
    // Check if content prop changed externally
    if (content !== previousContentRef.current) {
      previousContentRef.current = content;

      if (isMarkdown) {
        // IMMEDIATELY cancel any pending auto-save to prevent it from
        // overwriting the incoming external content with stale editor state.
        // Auto-save will re-arm naturally when the user makes further edits.
        cancelPendingSave();

        // For markdown files: use auto-save aware flow
        // Check if this is our own auto-save write
        isSelfWrite(content).then((selfWrite) => {
          if (selfWrite) {
            // Our own auto-save write — DO NOT touch editor state.
            // The editor already has the correct (or newer) content.
            // Updating currentContent here would overwrite any
            // characters the user typed since the save fired.
            return;
          }

          // External change (agent or other)
          if (isModified) {
            // Conflict! User has unsaved changes
            setConflictAgentContent(content);
          } else {
            // No local changes — apply with diff-based highlighting
            if (tiptapEditorRef.current) {
              tiptapEditorRef.current.applyAgentChange(content);
            }
            setCurrentContent(content);
            setExternalUpdateType("updated");
            setTimeout(() => setExternalUpdateType(null), 2000);
          }
        });
      } else {
        // Non-markdown files: original behavior
        if (!isModified) {
          setCurrentContent(content);
          setExternalUpdateType("updated");
          setTimeout(() => setExternalUpdateType(null), 2000);
        } else {
          setExternalUpdateType("changed_externally");
        }
      }
    }
    // Note: isModified is intentionally captured from the render closure but
    // NOT listed as a dependency — we only want to run when content changes.
    // The previousContentRef guard prevents re-processing on isModified changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, isMarkdown, isSelfWrite, cancelPendingSave]);

  // Track if content is modified
  useEffect(() => {
    setIsModified(currentContent !== content);
  }, [currentContent, content]);

  // Save file (for non-markdown or as fallback) - wrapped in useCallback for stable reference
  const handleSave = useCallback(async () => {
    if (!isModified || isSaving) return;

    // For markdown, use auto-save's saveNow
    if (isMarkdown) {
      await saveNow();
      setIsModified(false);
      return;
    }

    setIsSaving(true);
    setSaveMessage(null);

    try {
      if (isTauri()) {
        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        await writeTextFile(filePath, currentContent);
        setIsModified(false);
        setSaveMessage(t("app.saved", "Saved"));
        // Clear message after 2 seconds
        setTimeout(() => setSaveMessage(null), 2000);
      } else {
        setSaveMessage(t("app.cannotSaveWebMode", "Cannot save in web mode"));
        setTimeout(() => setSaveMessage(null), 3000);
      }
    } catch (error) {
      console.error("Failed to save file:", error);
      setSaveMessage(`Save failed: ${error}`);
      setTimeout(() => setSaveMessage(null), 3000);
    } finally {
      setIsSaving(false);
    }
  }, [isModified, isSaving, filePath, currentContent, t, isMarkdown, saveNow]);

  // Keyboard shortcut: Cmd+S / Ctrl+S for save
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleSave]);

  // --- Conflict resolution handlers ---
  const handleAcceptAgent = useCallback(() => {
    if (conflictAgentContent !== null) {
      if (tiptapEditorRef.current) {
        tiptapEditorRef.current.applyAgentChange(conflictAgentContent);
      }
      setCurrentContent(conflictAgentContent);
      setConflictAgentContent(null);
      setShowConflictDiff(false);
    }
  }, [conflictAgentContent]);

  const handleKeepMine = useCallback(() => {
    setConflictAgentContent(null);
    setShowConflictDiff(false);
    // Next auto-save will overwrite disk with user's version
  }, []);

  const handleViewConflictDiff = useCallback(() => {
    setShowConflictDiff((prev) => !prev);
  }, []);

  const handleConfirmClose = useCallback(() => {
    setShowCloseConfirm(false);
    onClose();
  }, [onClose]);

  const handleSaveAndClose = useCallback(async () => {
    setShowCloseConfirm(false);
    await handleSave();
    onClose();
  }, [handleSave, onClose]);

  // Save status indicator for markdown files
  const renderSaveStatusIndicator = () => {
    if (!isMarkdown) return null;
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 text-xs",
          saveStatus === "saved" && "text-green-500",
          saveStatus === "modified" && "text-amber-500",
          saveStatus === "saving" && "text-blue-500",
        )}
        title={
          saveStatus === "saved"
            ? t("app.saved", "Saved")
            : saveStatus === "saving"
              ? t("app.saving", "Saving...")
              : t("app.unsavedChanges", "Unsaved changes")
        }
      >
        {saveStatus === "saved" && (
          <>
            <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
            {t("app.saved", "Saved")}
          </>
        )}
        {saveStatus === "modified" && (
          <>
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          </>
        )}
        {saveStatus === "saving" && (
          <>
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("app.saving", "Saving...")}
          </>
        )}
      </span>
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* File tab header - simple and clean */}
      <div className="flex items-center h-10 px-3 border-b bg-muted/30 shrink-0 gap-3">
        {/* Full file path with status indicator */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground truncate">{filePath}</span>
          {isMarkdown ? (
            renderSaveStatusIndicator()
          ) : (
            isModified && (
              <span
                className="h-1.5 w-1.5 rounded-full bg-blue-500 shrink-0"
                title={t("app.unsavedChanges", "Unsaved changes")}
              />
            )
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 ml-auto">
          {/* Save button - only for non-markdown files */}
          {!isMarkdown && (
            <button
              onClick={handleSave}
              disabled={!isModified || isSaving}
              className={`p-1.5 rounded transition-colors ${
                isModified
                  ? "text-blue-600 hover:bg-blue-100 dark:hover:bg-blue-900/30"
                  : "text-muted-foreground/50"
              }`}
              title={isModified ? `Save (⌘S)` : t("app.noChanges", "No changes")}
            >
              {isSaving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
            </button>
          )}

          {/* Code toggle - only for HTML files (switch between preview and code) */}
          {previewType === "html" && (
            <button
              onClick={() => setShowPreview(!showPreview)}
              className={`p-1.5 rounded transition-colors ${
                !showPreview
                  ? "text-primary bg-primary/10"
                  : "text-muted-foreground hover:bg-muted"
              }`}
              title={
                !showPreview
                  ? t("app.preview", "Preview")
                  : t("app.editMode", "Edit mode")
              }
            >
              {!showPreview ? (
                <Eye className="h-4 w-4" />
              ) : (
                <Code className="h-4 w-4" />
              )}
            </button>
          )}

          {/* Diff toggle - icon only */}
          {hasChanges && (
            <button
              onClick={() => setShowDiff(!showDiff)}
              className={`p-1.5 rounded transition-colors ${
                showDiff
                  ? "text-primary bg-primary/10"
                  : "text-muted-foreground hover:bg-muted"
              }`}
              title={
                showDiff
                  ? t("app.editMode", "Edit mode")
                  : t("app.viewChanges", "View changes")
              }
            >
              {showDiff ? (
                <Code className="h-4 w-4" />
              ) : (
                <GitCompare className="h-4 w-4" />
              )}
            </button>
          )}

          {/* Change stats */}
          {hasChanges && (
            <span className="text-xs text-muted-foreground">
              <span className="text-green-600">
                +{fileDiff?.additions ?? gitDiffStats?.additions ?? 0}
              </span>{" "}
              <span className="text-red-500">
                -{fileDiff?.deletions ?? gitDiffStats?.deletions ?? 0}
              </span>
            </span>
          )}
        </div>

        {/* Save message - toast style (non-markdown only) */}
        {!isMarkdown && saveMessage && (
          <span
            className={`text-xs ${saveMessage.includes("failed") ? "text-red-500" : "text-green-500"}`}
          >
            {saveMessage}
          </span>
        )}

        {/* External update message (non-markdown only) */}
        {!isMarkdown && externalUpdateType && (
          <div className="flex items-center gap-2">
            <span
              className={`text-xs ${externalUpdateType === "changed_externally" ? "text-amber-500" : "text-green-500"}`}
            >
              {externalUpdateType === "updated"
                ? t("app.fileUpdated", "File updated")
                : t("app.fileChangedExternally", "File changed externally")}
            </span>
            {/* Show reload button if user has local changes and file changed externally */}
            {isModified && externalUpdateType === "changed_externally" && (
              <button
                onClick={() => {
                  setCurrentContent(content);
                  setExternalUpdateType(null);
                }}
                className="text-xs text-blue-500 hover:text-blue-600 underline"
              >
                {t("app.discardReload", "Discard & Reload")}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Conflict banner for markdown files */}
      {isMarkdown && conflictAgentContent !== null && (
        <ConflictBanner
          onAcceptAgent={handleAcceptAgent}
          onKeepMine={handleKeepMine}
          onViewDiff={handleViewConflictDiff}
          showingDiff={showConflictDiff}
        />
      )}

      {/* Viewer read-only banner */}
      {isViewerReadOnly && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800 text-xs text-amber-700 dark:text-amber-300">
          <Eye className="h-3.5 w-3.5" />
          {t('team.viewerReadOnly', 'Read-only mode — you don\'t have edit permissions')}
        </div>
      )}

      {/* Editor / Diff / Preview - file-type-routed */}
      <div className="flex-1 overflow-hidden">
        {/* Conflict diff view for markdown */}
        {isMarkdown && showConflictDiff && conflictAgentContent !== null ? (
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            }
          >
            <LazyDiffRenderer
              before={currentContent}
              after={conflictAgentContent}
              filePath={filePath}
              isDark={isDark}
            />
          </Suspense>
        ) : showDiff && hasChanges && (fileDiff || gitHeadContent !== null) ? (
          // Diff view - custom diff renderer with Shiki
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            }
          >
            <LazyDiffRenderer
              before={fileDiff?.before ?? gitHeadContent ?? ""}
              after={currentContent}
              filePath={filePath}
              isDark={isDark}
              onSendToAgent={(agentPrompt) => {
                // Send agent prompt to chat and switch to Agent tab
                const { sendMessage } = useSessionStore.getState();
                sendMessage(agentPrompt);
                useUIStore.getState().setFileModeRightTab("agent");
              }}
            />
          </Suspense>
        ) : (
          (() => {
            // Route to appropriate editor based on file type
            const editorType = getEditorType(filename);

            if (editorType === "markdown") {
              return (
                <Suspense
                  fallback={
                    <div className="flex items-center justify-center h-full">
                      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    </div>
                  }
                >
                  <LazyTiptapMarkdownEditor
                    ref={tiptapEditorRef}
                    content={currentContent}
                    filename={filename}
                    filePath={filePath}
                    onChange={(value) => setCurrentContent(value)}
                    isDark={isDark}
                    targetLine={targetLine}
                    targetHeading={targetHeading}
                    readOnly={isViewerReadOnly}
                  />
                </Suspense>
              );
            }

            // Code editor (default) - CodeMirror 6
            // For HTML files: toggle between full preview and full code editor
            return (
              <div className="flex h-full overflow-hidden">
                {showPreview && previewType === "html" ? (
                  // Full screen HTML preview
                  <div className="w-full bg-white">
                    <iframe
                      srcDoc={currentContent}
                      className="w-full h-full border-0"
                      sandbox="allow-scripts allow-same-origin"
                      title={t("app.htmlPreview", "HTML Preview")}
                    />
                  </div>
                ) : (
                  // Full screen code editor
                  <div className="w-full">
                    <Suspense
                      fallback={
                        <div className="flex items-center justify-center h-full">
                          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                        </div>
                      }
                    >
                      <LazyCodeEditor
                        content={currentContent}
                        filename={filename}
                        filePath={filePath}
                        onChange={(value) => setCurrentContent(value)}
                        isDark={isDark}
                        originalContent={gitHeadContent ?? fileDiff?.before ?? null}
                        targetLine={targetLine}
                        readOnly={isViewerReadOnly}
                    />
                  </Suspense>
                </div>
              )}
              </div>
            );
          })()
        )}
      </div>

      {/* Unsaved changes confirmation dialog (non-markdown only) */}
      <AlertDialog open={showCloseConfirm} onOpenChange={setShowCloseConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("app.unsavedChangesTitle", "Unsaved Changes")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "app.unsavedChangesMessage",
                "You have unsaved changes in this file. Do you want to save before closing?",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowCloseConfirm(false)}>
              {t("common.cancel", "Cancel")}
            </AlertDialogCancel>
            <Button variant="destructive" onClick={handleConfirmClose}>
              {t("app.discardChanges", "Don't Save")}
            </Button>
            <AlertDialogAction onClick={handleSaveAndClose}>
              {t("app.saveAndClose", "Save")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

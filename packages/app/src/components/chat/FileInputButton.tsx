import * as React from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { capabilities } from "@/lib/platform";

interface FileInputButtonProps {
  /** Desktop (Tauri): absolute filesystem paths from the native dialog. */
  onFilesSelected: (paths: string[]) => void;
  /**
   * Extension / web: browser File objects from `<input type="file">`.
   * Callers should route these through the same path as paste/drop.
   */
  onBrowserFilesSelected?: (files: File[]) => void;
}

export function FileInputButton({
  onFilesSelected,
  onBrowserFilesSelected,
}: FileInputButtonProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);

  const handleClick = async () => {
    // Extension / web: no Tauri dialog — trigger a hidden file input instead.
    if (!capabilities.tauriInvoke) {
      inputRef.current?.click();
      return;
    }

    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: true,
        title: "Select Files",
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length > 0) {
        onFilesSelected(paths);
      }
    } catch (error) {
      console.error("[FileInput] Failed to open file dialog:", error);
    }
  };

  const handleBrowserChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (list && list.length > 0) {
      onBrowserFilesSelected?.(Array.from(list));
    }
    // Allow re-selecting the same file(s).
    e.target.value = "";
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
        onClick={handleClick}
        aria-label="Attach files"
      >
        <Plus className="h-4 w-4" />
      </Button>
      {!capabilities.tauriInvoke ? (
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          data-testid="file-input-browser"
          onChange={handleBrowserChange}
        />
      ) : null}
    </>
  );
}

import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

interface FileInputButtonProps {
  onFilesSelected: (paths: string[]) => void;
}

export function FileInputButton({ onFilesSelected }: FileInputButtonProps) {
  const handleClick = async () => {
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

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-8 w-8 text-muted-foreground hover:text-foreground"
      onClick={handleClick}
    >
      <Plus className="h-4 w-4" />
    </Button>
  );
}

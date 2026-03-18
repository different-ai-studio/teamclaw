/**
 * TiptapHtmlEditor - Lightweight HTML editor using Tiptap in HTML mode.
 *
 * Features:
 * - Real-time HTML editing with WYSIWYG-like experience
 * - Live preview toggle (sandboxed iframe)
 * - File save (Cmd+S / Ctrl+S)
 * - Content modification tracking
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import { useTiptapExtensions } from "@/hooks/useTiptapExtensions";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { EditorProps } from "./types";
import { uploadImageFromPath, resolveImageSrc } from "./image-paste-handler";
import { TiptapToolbar } from "./TiptapToolbar";
import { TiptapSearchBar } from "./TiptapSearchBar";

interface TiptapHtmlEditorProps extends EditorProps {
  /** Whether to show preview mode */
  showPreview?: boolean;
}

export function TiptapHtmlEditor({
  content,
  filename: _filename,
  filePath: _filePath,
  onChange,
  readOnly = false,
  isDark = false,
  showPreview = false,
}: TiptapHtmlEditorProps) {
  const { t } = useTranslation();
  const [currentContent, setCurrentContent] = useState(content);
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const previousContentRef = useRef(content);

  const extensions = useTiptapExtensions({ imageConfig: { inline: true, allowBase64: false } })

  const editor = useEditor({
    extensions,
    content,
    editable: !readOnly,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      setCurrentContent(html);
      onChange?.(html);
    },
    editorProps: {
      attributes: {
        class: cn("max-w-none focus:outline-none min-h-full p-4"),
      },
    },
  });

  // Sync content when prop changes (external updates)
  useEffect(() => {
    if (content !== previousContentRef.current && editor) {
      previousContentRef.current = content;
      const editorHtml = editor.getHTML();
      if (editorHtml !== content) {
        editor.commands.setContent(content);
        setCurrentContent(content);
      }
    }
  }, [content, editor]);

  const handleImageUpload = useCallback(async () => {
    if (isProcessingImage || !editor) return;
    setIsProcessingImage(true);

    try {
      // Use Tauri's native dialog to pick an image file
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: "Images",
            extensions: ["png", "jpg", "jpeg", "gif", "webp"],
          },
        ],
      });

      if (!selected) {
        setIsProcessingImage(false);
        return;
      }

      const imagePath = selected as string;
      const result = await uploadImageFromPath(imagePath, _filePath);
      if (result.error) {
        toast.error(result.error);
      } else if (result.absolutePath) {
        // Convert absolute path to asset URL and insert as Image node
        const filename = result.absolutePath.split('/').pop() || '';
        const src = await resolveImageSrc(`_assets/${filename}`, _filePath);
        editor.chain().focus().setImage({ src }).run();
      }
    } catch (err) {
      toast.error(t("editor.imagePasteFailed", "Failed to upload image"));
      console.error("Image upload error:", err);
    } finally {
      setIsProcessingImage(false);
    }
  }, [editor, _filePath, isProcessingImage, t]);

  if (showPreview) {
    return (
      <div className="h-full overflow-auto bg-background">
        <iframe
          srcDoc={currentContent}
          className="w-full h-full border-0"
          sandbox="allow-scripts allow-same-origin"
          title={t("app.htmlPreview", "HTML Preview")}
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "h-full flex flex-col",
        isDark ? "bg-[#1e1e1e]" : "bg-background",
      )}
    >
      {!readOnly && (
        <div className="flex-shrink-0">
          <TiptapToolbar
            editor={editor}
            isDark={isDark}
            onImageUpload={handleImageUpload}
          />
        </div>
      )}
      <TiptapSearchBar editor={editor} />
      <div
        className={cn(
          "flex-1 overflow-auto",
          isDark ? "bg-[#1e1e1e]" : "bg-white",
        )}
      >
        <div className={cn("rounded-lg shadow-sm", isDark ? "" : "bg-white")}>
          <EditorContent editor={editor} className="h-full" />
        </div>
      </div>
    </div>
  );
}

export default TiptapHtmlEditor;

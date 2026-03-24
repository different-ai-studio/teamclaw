/**
 * TiptapMarkdownEditor - WYSIWYG markdown editor using Tiptap.
 *
 * Features:
 * - Real-time WYSIWYG markdown editing (edit and preview unified)
 * - Auto-save (no save button needed)
 * - Agent change highlighting with character-level decorations
 * - Diff-aware external content sync preserving cursor position
 * - Image paste and auto-upload to _assets directory
 */

import { useCallback, useEffect, useRef, useState, useImperativeHandle, forwardRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { Markdown } from "@tiptap/markdown";
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";
import { useTranslation } from "react-i18next";
import { useTiptapExtensions } from "@/hooks/useTiptapExtensions";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { EditorProps } from "./types";
import {
  detectClipboardImage,
  saveClipboardImage,
  uploadImageFromPath,
  resolveImageSrc,
  resolveMarkdownImages,
  unresolveMarkdownImages,
} from "./image-paste-handler";
import { TiptapToolbar } from "./TiptapToolbar";
import { TableBubbleMenu } from "./TableBubbleMenu";
import { TiptapSearchBar } from "./TiptapSearchBar";
import { AgentHighlight, agentHighlightKey } from "./AgentHighlight";
import { computeAgentChanges } from "./pm-diff-engine";
import type { AgentHighlightMeta } from "./AgentHighlight";

/** Methods exposed to parent via ref */
export interface TiptapEditorHandle {
  /** Apply external content with diff-based highlighting */
  applyAgentChange: (newMarkdown: string) => Promise<void>;
  /** Get current markdown content */
  getMarkdown: () => string;
}

const LARGE_CHANGE_THRESHOLD = 50; // percent

export const TiptapMarkdownEditor = forwardRef<TiptapEditorHandle, EditorProps>(
  function TiptapMarkdownEditor(
    {
      content,
      filename: _filename,
      filePath,
      onChange,
      readOnly = false,
      isDark = false,
      targetLine,
      targetHeading,
    },
    ref,
  ) {
    const { t } = useTranslation();
    const [isProcessingImage, setIsProcessingImage] = useState(false);
    const [isReady, setIsReady] = useState(false);
    const [rawMode, setRawMode] = useState(false);
    const [rawContent, setRawContent] = useState(content);
    const rawModeRef = useRef(rawMode);
    rawModeRef.current = rawMode;
    const rawContentRef = useRef(rawContent);
    rawContentRef.current = rawContent;
    const previousContentRef = useRef(content);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

    const baseExtensions = useTiptapExtensions({
      imageConfig: { inline: false, allowBase64: true },
      extraExtensions: [
        Markdown,
        Table.configure({ resizable: false, HTMLAttributes: { class: "tiptap-table" } }),
        TableRow,
        TableCell,
        TableHeader,
        AgentHighlight,
      ],
    })

    const editor = useEditor({
      extensions: baseExtensions,
      content: "", // Start empty; real content set after image resolution
      contentType: "markdown",
      editable: !readOnly,
      onUpdate: ({ editor }) => {
        // Get markdown content and convert asset URLs back to relative paths
        // Decorations (AgentHighlight) don't affect getMarkdown output
        const md = editor.getMarkdown();
        const cleaned = unresolveMarkdownImages(md, filePath);
        onChangeRef.current?.(cleaned);
      },
      editorProps: {
        attributes: {
          class: cn("max-w-none focus:outline-none min-h-full p-4"),
        },
        handlePaste: (_view, event) => {
          // Check for image in clipboard
          const imageFile = detectClipboardImage(
            event as unknown as ClipboardEvent,
          );
          if (imageFile) {
            event.preventDefault();
            handleImagePaste(imageFile);
            return true;
          }
          return false;
        },
      },
    });

    // Resolve image paths when content is first loaded
    useEffect(() => {
      if (!editor) return;

      let cancelled = false;
      const loadContent = async () => {
        // Resolve relative image paths to Tauri asset URLs
        const resolved = await resolveMarkdownImages(content, filePath);
        if (cancelled) return;
        editor.commands.setContent(resolved, { contentType: "markdown" });
        previousContentRef.current = content;
        setIsReady(true);
      };

      loadContent();
      return () => {
        cancelled = true;
      };
      // Only run on initial mount
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editor]);

    // Apply agent change with diff-based highlighting, then scroll to first change
    const applyAgentChange = useCallback(
      async (newMarkdown: string) => {
        // In raw mode, just update the text content directly
        if (rawModeRef.current) {
          setRawContent(newMarkdown);
          previousContentRef.current = newMarkdown;
          return;
        }

        if (!editor || !isReady) return;

        // Get old doc for diffing
        const oldDoc = editor.state.doc;

        // Resolve images and set content
        const resolved = await resolveMarkdownImages(newMarkdown, filePath);
        editor.commands.setContent(resolved, { contentType: "markdown" });

        // Update the tracked content reference
        previousContentRef.current = newMarkdown;

        // Get the new doc after setContent
        const newDoc = editor.state.doc;

        // Compute diff between old and new for highlighting
        const { ranges, changePercent } = computeAgentChanges(oldDoc, newDoc);

        if (changePercent > LARGE_CHANGE_THRESHOLD) {
          // Large change — show toast instead of per-character highlights
          toast.info(
            t(
              "editor.documentRewrittenByAgent",
              "Document rewritten by agent",
            ),
          );
        } else if (ranges.length > 0) {
          // Apply character-level highlights
          editor.view.dispatch(
            editor.state.tr.setMeta(agentHighlightKey, {
              action: "add",
              ranges,
            } as AgentHighlightMeta),
          );
        }

        // Scroll to the first change so the user can see what the agent modified.
        // For large rewrites we scroll to the top; for targeted edits we jump to
        // the first highlighted range.
        if (ranges.length > 0) {
          const firstRange = ranges[0];
          const maxPos = editor.state.doc.content.size;
          const targetPos = Math.min(firstRange.from, maxPos);

          try {
            editor.commands.setTextSelection(targetPos);
          } catch {
            // noop
          }

          // Use scrollIntoView to bring the first change into the viewport.
          // We do this in a rAF so the DOM has updated with the new content first.
          requestAnimationFrame(() => {
            editor.commands.scrollIntoView();
          });
        } else {
          // No specific ranges (e.g. large rewrite or pure deletion) — scroll to top
          try {
            editor.commands.setTextSelection(0);
          } catch {
            // noop
          }
          const scrollEl = editor.view.dom.closest(".overflow-auto");
          if (scrollEl) {
            requestAnimationFrame(() => {
              scrollEl.scrollTop = 0;
            });
          }
        }
      },
      [editor, filePath, isReady, t],
    );

    // Expose methods via ref
    useImperativeHandle(
      ref,
      () => ({
        applyAgentChange,
        getMarkdown: () => {
          if (rawModeRef.current) return rawContentRef.current;
          if (!editor) return "";
          return unresolveMarkdownImages(editor.getMarkdown(), filePath);
        },
      }),
      [applyAgentChange, editor, filePath],
    );

    // Sync content when prop changes (external updates from FileEditor)
    useEffect(() => {
      if (!isReady) return;
      if (content !== previousContentRef.current) {
        previousContentRef.current = content;

        // In raw mode, just update the text directly
        if (rawMode) {
          setRawContent(content);
          return;
        }

        if (!editor) return;
        let cancelled = false;
        const sync = async () => {
          const resolved = await resolveMarkdownImages(content, filePath);
          if (cancelled) return;
          // Only update if content actually differs (normalize trailing whitespace
          // to avoid false positives from markdown serialization round-trips)
          const currentMd = unresolveMarkdownImages(
            editor.getMarkdown(),
            filePath,
          );
          const normalizedCurrent = currentMd.replace(/\s+$/, "");
          const normalizedNew = content.replace(/\s+$/, "");
          if (normalizedCurrent !== normalizedNew) {
            // Save cursor position and scroll state
            const savedFrom = editor.state.selection.from;
            const scrollEl = editor.view.dom.closest(".overflow-auto");
            const savedScrollTop = scrollEl?.scrollTop ?? 0;

            editor.commands.setContent(resolved, {
              contentType: "markdown",
            });

            // Restore cursor position
            const maxPos = editor.state.doc.content.size;
            try {
              editor.commands.setTextSelection(Math.min(savedFrom, maxPos));
            } catch {
              // noop
            }

            // Restore scroll position
            if (scrollEl) {
              requestAnimationFrame(() => {
                scrollEl.scrollTop = savedScrollTop;
              });
            }
          }
        };
        sync();
        return () => {
          cancelled = true;
        };
      }
    }, [content, editor, filePath, isReady, rawMode]);

    // Toggle between WYSIWYG and raw source mode
    const handleToggleRaw = useCallback(async () => {
      if (!editor) return;
      if (!rawMode) {
        // WYSIWYG → raw: extract current markdown
        const md = unresolveMarkdownImages(editor.getMarkdown(), filePath);
        setRawContent(md);
        setRawMode(true);
      } else {
        // raw → WYSIWYG: push raw content back into editor
        const resolved = await resolveMarkdownImages(rawContent, filePath);
        editor.commands.setContent(resolved, { contentType: "markdown" });
        previousContentRef.current = rawContent;
        setRawMode(false);
      }
    }, [editor, rawMode, rawContent, filePath]);

    // Handle raw textarea changes
    const handleRawChange = useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const val = e.target.value;
        setRawContent(val);
        previousContentRef.current = val;
        onChangeRef.current?.(val);
      },
      [],
    );

    // Handle image paste - upload to _assets and insert as Image node
    const handleImagePaste = useCallback(
      async (imageFile: File) => {
        if (isProcessingImage) return;
        setIsProcessingImage(true);

        try {
          const result = await saveClipboardImage(imageFile, filePath);
          if (result.error) {
            toast.error(result.error);
            return;
          }
          if (result.absolutePath && editor) {
            // Convert absolute file path to asset URL for display
            const src = await resolveImageSrc(
              `_assets/${result.absolutePath.split("/").pop()}`,
              filePath,
            );
            editor.chain().focus().setImage({ src }).run();
          }
        } catch (err) {
          toast.error(t("editor.imagePasteFailed", "Failed to paste image"));
          console.error("Image paste error:", err);
        } finally {
          setIsProcessingImage(false);
        }
      },
      [editor, filePath, isProcessingImage, t],
    );

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
        const result = await uploadImageFromPath(imagePath, filePath);
        if (result.error) {
          toast.error(result.error);
        } else if (result.absolutePath) {
          // Convert absolute path to asset URL and insert as Image node
          const src = await resolveImageSrc(
            `_assets/${result.absolutePath.split("/").pop()}`,
            filePath,
          );
          editor.chain().focus().setImage({ src }).run();
        }
      } catch (err) {
        toast.error(t("editor.imagePasteFailed", "Failed to upload image"));
        console.error("Image upload error:", err);
      } finally {
        setIsProcessingImage(false);
      }
    }, [editor, filePath, isProcessingImage, t]);

    // Handle target heading - scroll to the matching heading in the document
    useEffect(() => {
      if (!editor || !targetHeading) return;
      
      // Wait for content to be loaded
      if (editor.state.doc.textContent.length === 0) {
        const timer = setTimeout(() => {
          if (editor && editor.state.doc.textContent.length > 0) {
            searchAndScrollToHeading();
          }
        }, 100);
        return () => clearTimeout(timer);
      }
      
      searchAndScrollToHeading();
      
      function searchAndScrollToHeading() {
        if (!editor) return;
        
        // Search for the heading node in the document
        let foundPos: number | null = null;
        
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name === 'heading') {
            const headingText = node.textContent;
            
            if (headingText === targetHeading) {
              foundPos = pos;
              return false; // Stop traversing
            }
          }
          return true; // Continue
        });
        
        if (foundPos !== null) {
          // Found the heading - scroll to it
          const headingPos = foundPos; // Copy to avoid null check issues in closure
          
          // Set cursor position at the heading
          editor.commands.focus(headingPos);
          
          // Scroll with custom offset to account for header/toolbar
          // Use scrollIntoView directly on the DOM element for better control
          setTimeout(() => {
            const { view } = editor;
            const coords = view.coordsAtPos(headingPos);
            
            // Get the editor container
            const editorDom = view.dom;
            const scrollContainer = editorDom.closest('.overflow-auto');
            
            if (scrollContainer && coords) {
              // Calculate scroll position with offset (100px above the heading)
              const scrollOffset = 100;
              const targetScroll = coords.top - scrollContainer.getBoundingClientRect().top + scrollContainer.scrollTop - scrollOffset;
              
              scrollContainer.scrollTo({
                top: targetScroll,
                behavior: 'smooth'
              });
            } else {
              // Fallback to default scroll
              editor.commands.scrollIntoView();
            }
          }, 50);
        } else {
          // Heading not found - scroll to top as fallback
          editor.commands.focus('start');
          editor.commands.scrollIntoView();
        }
      }
    }, [editor, targetHeading]);
    
    // Handle target line - for code mode or if no heading is provided
    useEffect(() => {
      if (!editor || targetLine == null || targetHeading != null) return;
      
      // If no heading, scroll to top (Markdown chunks without specific heading)
      editor.commands.focus('start');
      editor.commands.scrollIntoView();
    }, [editor, targetLine, targetHeading]);

    return (
      <div
        className={cn(
          "h-full flex flex-col",
          isDark ? "bg-[#1e1e1e]" : "bg-background",
        )}
      >
        {(!readOnly || rawMode) && (
          <div className="flex-shrink-0">
            <TiptapToolbar
              editor={editor}
              isDark={isDark}
              onImageUpload={!rawMode ? handleImageUpload : undefined}
              rawMode={rawMode}
              onToggleRaw={handleToggleRaw}
            />
          </div>
        )}
        {!rawMode && <TiptapSearchBar editor={editor} />}
        <div
          className={cn(
            "flex-1 overflow-auto flex flex-col",
            isDark ? "bg-[#1e1e1e]" : "bg-white",
          )}
        >
          {rawMode ? (
            <textarea
              value={rawContent}
              onChange={handleRawChange}
              readOnly={readOnly}
              spellCheck={false}
              className={cn(
                "flex-1 w-full h-full resize-none p-4 font-mono text-sm leading-relaxed focus:outline-none",
                isDark
                  ? "bg-[#1e1e1e] text-[#d4d4d4]"
                  : "bg-white text-foreground",
              )}
            />
          ) : (
            <>
              {isProcessingImage && (
                <div className="absolute top-2 right-2 z-10 text-xs text-muted-foreground bg-background/80 px-2 py-1 rounded">
                  {t("editor.uploadingImage", "Uploading image...")}
                </div>
              )}
              <EditorContent
                editor={editor}
                className="flex-1 [&_.tiptap]:min-h-full"
              />
              {editor && !readOnly && <TableBubbleMenu editor={editor} />}
            </>
          )}
        </div>
      </div>
    );
  },
);

export default TiptapMarkdownEditor;

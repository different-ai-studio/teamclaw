/**
 * Shared types for all editor components.
 */

export interface EditorProps {
  /** File content to display/edit */
  content: string;
  /** Filename (used for language detection, title, etc.) */
  filename: string;
  /** Full file path (used for save operations, image upload, etc.) */
  filePath: string;
  /** Callback when content changes */
  onChange?: (content: string) => void;
  /** Whether the editor is read-only */
  readOnly?: boolean;
  /** Current theme (dark/light) */
  isDark?: boolean;
  /** Original content from git HEAD (for git gutter decorations) */
  originalContent?: string | null;
  /** Line number to scroll to (1-indexed, for code files) */
  targetLine?: number | null;
  /** Heading text to scroll to (for Markdown files) */
  targetHeading?: string | null;
}

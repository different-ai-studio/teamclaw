import { useState, useEffect } from "react";
import {
  Clock,
  Search,
  FileText,
  Terminal,
  Globe,
  Zap,
  HelpCircle,
  Loader2,
  Check,
  X,
} from "lucide-react";
import type { ToolCall } from "@/stores/session";

export const statusConfig = {
  calling: {
    icon: Loader2,
    bgColor: "bg-muted/30",
    textColor: "text-muted-foreground",
    borderColor: "border-border",
    label: "Running",
    animate: true,
  },
  completed: {
    icon: Check,
    bgColor: "bg-muted/20",
    textColor: "text-foreground/60",
    borderColor: "border-border",
    label: "Done",
    animate: false,
  },
  failed: {
    icon: X,
    bgColor: "bg-muted/30",
    textColor: "text-red-600 dark:text-red-500",
    borderColor: "border-border",
    label: "Failed",
    animate: false,
  },
  waiting: {
    icon: Clock,
    bgColor: "bg-muted/30",
    textColor: "text-muted-foreground",
    borderColor: "border-border",
    label: "Waiting",
    animate: true,
  },
};

// Get appropriate icon based on tool name
export function getToolIcon(toolName: string) {
  const name = toolName.toLowerCase();
  if (name === "question") {
    return HelpCircle;
  }
  if (
    name.includes("search") ||
    name.includes("web") ||
    name.includes("fetch")
  ) {
    return Globe;
  }
  if (
    name.includes("file") ||
    name.includes("read") ||
    name.includes("write")
  ) {
    return FileText;
  }
  if (
    name.includes("bash") ||
    name.includes("shell") ||
    name.includes("terminal")
  ) {
    return Terminal;
  }
  if (name.includes("find") || name.includes("grep")) {
    return Search;
  }
  return Zap;
}

// Check if this is a question tool
export function isQuestionTool(toolName: string): boolean {
  return toolName.toLowerCase() === "question";
}

// Check if this is a Write tool
export function isWriteTool(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "write" || name === "write_file" || name === "writefile";
}

// Check if this is an Edit tool
export function isEditTool(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return (
    name === "edit" ||
    name === "edit_file" ||
    name === "editfile" ||
    name === "str_replace" ||
    name === "strreplace" ||
    name === "apply_patch" ||
    name === "applypatch"
  );
}

// Check if this is a Read tool
export function isReadTool(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "read" || name === "read_file" || name === "readfile";
}

// Check if this is a command tool (bash, shell, terminal, run_command)
export function isCommandTool(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return (
    name.includes("bash") ||
    name.includes("shell") ||
    name.includes("terminal") ||
    name.includes("run_command")
  );
}

// Check if this is a Task tool (subagent)
export function isTaskTool(toolName: string): boolean {
  return toolName.toLowerCase() === "task";
}

// Check if this is a Skill tool
export function isSkillTool(toolName: string): boolean {
  return toolName.toLowerCase() === "skill";
}

// Get file extension from path
export function getFileExtension(path: string): string {
  const parts = path.split(".");
  return parts.length > 1 ? parts.pop()?.toLowerCase() || "" : "";
}

// Get language name for display
export function getLanguageName(ext: string): string {
  const langMap: Record<string, string> = {
    ts: "TypeScript",
    tsx: "TypeScript",
    js: "JavaScript",
    jsx: "JavaScript",
    py: "Python",
    rb: "Ruby",
    go: "Go",
    rs: "Rust",
    java: "Java",
    cpp: "C++",
    c: "C",
    h: "C Header",
    css: "CSS",
    scss: "SCSS",
    html: "HTML",
    json: "JSON",
    yaml: "YAML",
    yml: "YAML",
    md: "Markdown",
    sql: "SQL",
    sh: "Shell",
    bash: "Bash",
    zsh: "Zsh",
    toml: "TOML",
    xml: "XML",
    swift: "Swift",
    kt: "Kotlin",
  };
  return langMap[ext] || ext.toUpperCase();
}

// Format tool name for display
export function formatToolName(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (str) => str.toUpperCase())
    .trim();
}

// Get filename from path
export function getFileName(path: string): string {
  return path.split("/").pop() || path;
}

// Timeout threshold for tool calls (2 minutes)
const TOOL_CALL_TIMEOUT_MS = 2 * 60 * 1000;

// Hook to detect if a tool call has timed out
export function useToolCallTimeout(toolCall: ToolCall): boolean {
  const [isTimedOut, setIsTimedOut] = useState(false);

  useEffect(() => {
    if (toolCall.status !== "calling" || !toolCall.startTime) {
      setIsTimedOut(false);
      return;
    }

    const elapsed = Date.now() - toolCall.startTime.getTime();
    if (elapsed >= TOOL_CALL_TIMEOUT_MS) {
      setIsTimedOut(true);
      return;
    }

    const remaining = TOOL_CALL_TIMEOUT_MS - elapsed;
    const timer = setTimeout(() => setIsTimedOut(true), remaining);
    return () => clearTimeout(timer);
  }, [toolCall.status, toolCall.startTime]);

  return isTimedOut;
}

// Extract file path from tool call arguments, trying multiple possible field names
export function extractFilePath(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const path =
    args.path || args.file || args.filePath || args.filepath ||
    args.file_path || args.filename || args.target_file || args.targetFile || "";
  return String(path);
}

const PATCH_ARG_KEYS = [
  "patch",
  "diff",
  "unifiedDiff",
  "unified_diff",
  "udiff",
] as const;

/**
 * Extract raw patch / unified-diff text from apply_patch (and similar) tool arguments.
 */
export function extractPatchTextFromToolArgs(
  args: Record<string, unknown> | undefined,
): string | null {
  if (!args) return null;

  for (const k of PATCH_ARG_KEYS) {
    const v = args[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }

  const content = args.content;
  if (typeof content === "string" && content.trim().length > 0) {
    const t = content.trim();
    if (
      t.startsWith("diff --git") ||
      t.includes("*** Begin Patch") ||
      t.startsWith("--- ") ||
      t.includes("\n@@")
    ) {
      return content;
    }
  }

  for (const v of Object.values(args)) {
    if (typeof v !== "string" || v.trim().length === 0) continue;
    const t = v.trim();
    if (t.startsWith("diff --git") || t.includes("*** Begin Patch")) {
      return v;
    }
  }

  return null;
}

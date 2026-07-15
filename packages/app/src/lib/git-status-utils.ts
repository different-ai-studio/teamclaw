// Git status display utilities — extracted from FileTree.tsx
// Pure functions, no component dependencies

import {
  Circle,
  Plus,
  Minus,
  Pencil,
  HelpCircle,
  Check,
  ArrowRight,
  type LucideIcon,
} from "lucide-react";
import { GitStatus } from "@/lib/git/service";

// Color-blind friendly: use distinct icons per Git status alongside colors
// Uses custom colors from settings store
export function getGitStatusIndicator(
  status: GitStatus,
  customColors: Record<GitStatus, string>,
  t: (key: string, fallback: string) => string,
): { Icon: LucideIcon; color: string; label: string } {
  const color = customColors[status] || "text-amber-500";
  switch (status) {
    case GitStatus.MODIFIED:
      return { Icon: Pencil, color, label: t("git.modified", "Modified") };
    case GitStatus.ADDED:
      return { Icon: Plus, color, label: t("git.added", "Added") };
    case GitStatus.DELETED:
      return { Icon: Minus, color, label: t("git.deleted", "Deleted") };
    case GitStatus.UNTRACKED:
      return {
        Icon: HelpCircle,
        color,
        label: t("git.untracked", "Untracked"),
      };
    case GitStatus.STAGED:
      return { Icon: Check, color, label: t("git.staged", "Staged") };
    case GitStatus.RENAMED:
      return { Icon: ArrowRight, color, label: t("git.renamed", "Renamed") };
    default:
      return { Icon: Circle, color, label: t("git.changed", "Changed") };
  }
}

// Get text color class for git status (VS Code / Cursor style)
export function getGitStatusTextColor(
  status: GitStatus | null,
  customColors: Record<GitStatus, string>,
): string {
  if (!status) return "";
  return customColors[status] || "text-amber-500";
}

import type { PendingPermissionEntry } from "@/stores/session-types";

export type PermissionTranslateFn = (
  key: string,
  fallback?: string,
  options?: Record<string, unknown>,
) => string;

function getPermissionMeta(
  t: PermissionTranslateFn,
): Record<string, { glyph: string; title: string; subject: string }> {
  return {
    bash: {
      glyph: ">",
      title: t("chat.permissionCard.requestExecuteCommand", "Request command execution"),
      subject: t("chat.toolCall.permission.bash", "Bash"),
    },
    execute: {
      glyph: ">",
      title: t("chat.permissionCard.requestExecuteCommand", "Request command execution"),
      subject: t("chat.toolCall.permission.bash", "Bash"),
    },
    write: {
      glyph: "✎",
      title: t("chat.permissionCard.requestWriteFile", "Request file write"),
      subject: t("permission.write", "Write"),
    },
    edit: {
      glyph: "✎",
      title: t("chat.permissionCard.requestEditFile", "Request file edit"),
      subject: t("permission.edit", "Edit"),
    },
    read: {
      glyph: "📄",
      title: t("chat.permissionCard.requestReadFile", "Request file read"),
      subject: t("permission.read", "Read"),
    },
    external_directory: {
      glyph: "📄",
      title: t("chat.permissionCard.requestAccessExternalPath", "Request external path access"),
      subject: t("permission.read", "Read"),
    },
    skill: {
      glyph: "⚡",
      title: t("chat.permissionCard.requestRunSkill", "Request skill run"),
      subject: t("chat.toolCall.skill.title", "Skill"),
    },
  };
}

function getSourceToolLabel(t: PermissionTranslateFn, sourceToolName?: string | null) {
  if (!sourceToolName) return null;
  const normalized = sourceToolName.toLowerCase();
  if (
    normalized.includes("bash") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return t("chat.toolCall.permission.bash", "Bash");
  }
  if (normalized === "write") return t("permission.write", "Write");
  if (normalized === "edit") return t("permission.edit", "Edit");
  if (normalized === "read") return t("permission.read", "Read");
  if (normalized === "skill") return t("chat.toolCall.skill.title", "Skill");
  return sourceToolName;
}

function truncateMiddle(
  value: string,
  maxLength: number,
  headLength: number,
  tailLength: number,
) {
  if (value.length <= maxLength) return value;
  const head = value.slice(0, headLength).trimEnd();
  const tail = value.slice(-tailLength).trimStart();
  return `${head} ... ${tail}`;
}

function summarizePermissionDetail(detail: string, permType: string) {
  const normalized = detail.replace(/\s+/g, " ").trim();
  if (!normalized) return detail;

  if (permType === "bash" || permType === "execute") {
    return truncateMiddle(normalized, 92, 42, 24);
  }

  if (normalized.includes("/")) {
    return truncateMiddle(normalized, 88, 22, 30);
  }

  return normalized.length > 88 ? truncateMiddle(normalized, 88, 40, 20) : normalized;
}

export function getPermissionCardPresentation(
  entry: PendingPermissionEntry,
  t: PermissionTranslateFn,
) {
  const permType = entry.permission.permission || "write";
  const isExternal = permType === "external_directory";
  const permissionMeta = getPermissionMeta(t);
  const baseMeta = permissionMeta[permType] || {
    glyph: "•",
    title: t("permission.request", "Request permission"),
    subject: t("chat.toolCall.permission.tool", "Tool"),
  };
  const sourceToolLabel = getSourceToolLabel(t, entry.sourceToolName);
  const meta = {
    ...baseMeta,
    subject: isExternal && sourceToolLabel ? sourceToolLabel : baseMeta.subject,
  };

  const metadata = entry.permission.metadata as Record<string, string> | undefined;
  const commandText = entry.permission.patterns?.join(" ") || "";
  const filePath = metadata?.file || metadata?.filepath || "";
  const skillName = metadata?.skill || metadata?.name || "";
  const firstPattern = entry.permission.patterns?.[0] || "";

  const detail = (() => {
    if (permType === "bash" || permType === "execute") {
      return commandText || firstPattern || permType;
    }
    if (filePath) {
      return filePath;
    }
    if (permType === "skill") {
      return skillName || firstPattern || t("chat.permissionCard.requestedSkill", "Requested skill");
    }
    if (firstPattern) {
      return firstPattern;
    }
    return permType;
  })();

  const subtitle = isExternal
    ? sourceToolLabel
      ? t("chat.permissionCard.sourceToolInvocation", "From {{tool}} tool call", {
          tool: sourceToolLabel,
        })
      : t(
          "chat.permissionCard.waitingExternalPathApproval",
          "Confirmation is required before accessing a path outside the workspace",
        )
    : entry.childSessionId
      ? t(
          "chat.permissionCard.childSessionWaitingApproval",
          "A child session is waiting for your approval",
        )
      : sourceToolLabel
        ? t("chat.permissionCard.sourceToolInvocation", "From {{tool}} tool call", {
            tool: sourceToolLabel,
          })
        : t(
            "chat.permissionCard.toolInvocationWaitingApproval",
            "A tool call is waiting for your approval",
          );

  return { meta, detail: summarizePermissionDetail(detail, permType), subtitle };
}

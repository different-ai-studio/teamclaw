export type ShortcutNodeType = "folder" | "url" | "team" | "session" | "external";

export type ShortcutScope = "personal" | "team";

export type Shortcut = {
  id: string;
  label: string;
  icon: string | null;
  nodeType: ShortcutNodeType;
  target: string | null;
  order: number;
  parentId: string | null;
  scope: ShortcutScope;
};

export function isLeafShortcut(node: Shortcut): boolean {
  return node.nodeType !== "folder" && Boolean(node.target);
}

# Shortcut Role Filtering Design

## Context

Team shortcuts are loaded from `teamclaw-team/_meta/shortcuts.json` and displayed through the shortcuts store and `ShortcutsPanel`. Team members are loaded from `teamclaw-team/_meta/members.json` through the shared Rust `TeamMember` type and the frontend team members store.

The goal is to let a team member see only the team shortcuts intended for one or more shortcut roles.

## Data Model

Each member may include a `shortcutsRole` array:

```json
{
  "nodeId": "abc123",
  "name": "Alice",
  "role": "editor",
  "shortcutsRole": ["sales", "support"]
}
```

Each shortcut may include a `role` array:

```json
{
  "id": "shortcut-crm",
  "label": "CRM",
  "type": "link",
  "target": "https://crm.example.com",
  "parentId": null,
  "order": 0,
  "role": ["sales"]
}
```

Both fields default to empty arrays. Existing files without these fields remain valid.

## Visibility Rules

Personal shortcuts are unchanged.

Team shortcuts are filtered by the current device's team member record:

- If a shortcut has no `role` field, or `role` is an empty array, it is visible to everyone.
- If a shortcut has one or more roles, it is visible only when the current member's `shortcutsRole` has at least one matching value.
- If the current member is unavailable, only unrestricted team shortcuts are visible.
- Folder nodes are preserved when the folder itself is visible or any child remains visible after filtering. Restricted folders with no visible descendants are hidden.

Role values are treated as exact string identifiers. The app will not enforce a predefined role list in this change.

## Architecture

The filtering belongs in the frontend shortcuts store, not in the file loader or the panel:

- `ShortcutNode` gains `role?: string[]`.
- `TeamMember` gains `shortcutsRole?: string[]`.
- The shortcuts store tracks the current member shortcut roles and applies filtering in `getTeamTree()` and `getTree()`.
- Existing callers of `getTeamTree()` and `getTree()` automatically receive filtered team shortcuts.
- `loadTeamShortcutsFile()` continues to parse and save the full `shortcuts.json` content without applying visibility logic.

Rust shared member types gain `shortcuts_role: Vec<String>` with `#[serde(default)]`, serialized as `shortcutsRole`. All code paths that construct `TeamMember` initialize it to an empty array so newly written `members.json` files include the field.

## Data Flow

On app startup, team shortcuts and team members may load in either order. The shortcuts store should support updating current member shortcut roles independently from loaded shortcut nodes so the visible tree recalculates on the next render.

On `_meta/shortcuts.json` file watcher reloads, the full team shortcut list is replaced, then the existing current member roles are reapplied by the tree selectors.

## Testing

Unit coverage should include:

- Existing unrestricted shortcuts remain visible when `role` is missing.
- Existing unrestricted shortcuts remain visible when `role` is an empty array.
- Restricted shortcuts are visible when `shortcutsRole` intersects with `role`.
- Restricted shortcuts are hidden when there is no intersection or no current member roles are loaded.
- Folder filtering preserves a parent when any child remains visible.
- Saved team shortcuts preserve the `role` property.

Rust compile/type checks should cover the shared `TeamMember` schema change.

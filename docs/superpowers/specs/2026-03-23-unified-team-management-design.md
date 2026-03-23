# Unified Team Management Design

## Problem

TeamClaw supports 4 team sync modes (OSS/S3, P2P, WebDAV, Git). The team member management experience is fragmented:
- P2P has relatively complete member management (NodeId, roles, allowlist)
- OSS has only `Owner | Member` roles with no device-level identity
- No unified flow for creating teams, inviting members, or managing roles

## Goal

Unify the team management experience across OSS and P2P modes with a consistent flow:
1. Owner creates team
2. Member shares their NodeId (Iroh Ed25519 public key) with Owner
3. Owner adds member info (name, NodeId, label, role)
4. Owner gives member team ID + ticket
5. Member joins with ticket; validated against NodeId allowlist
6. Team member list visible to all; editable by Owner and Editor only

## Data Model

### Unified Role Enum

```
Owner | Editor | Viewer
```

**Permissions:**
| Action | Owner | Editor | Viewer |
|---|---|---|---|
| Manage members (add/remove/edit) | Yes | Yes | No |
| View member list | Yes | Yes | Yes |
| Sync files (read/write) | Yes | Yes | Read-only |

### Unified TeamMember

Reuse the existing P2P `TeamMember` struct for both modes:

```rust
pub enum MemberRole {
    Owner,
    #[default]
    Editor,
    Viewer,
}

pub struct TeamMember {
    pub node_id: String,       // Iroh NodeId (Ed25519 public key)
    pub name: String,          // Display name
    pub role: MemberRole,
    pub label: String,         // Remark/note
    pub platform: String,      // OS
    pub arch: String,          // CPU architecture
    pub hostname: String,      // Machine hostname
    pub added_at: String,      // ISO 8601 timestamp
}
```

TypeScript equivalent:

```typescript
interface TeamMember {
  nodeId: string
  name: string
  role: 'owner' | 'editor' | 'viewer'
  label: string
  platform: string
  arch: string
  hostname: string
  addedAt: string
}
```

### Member Storage

- **P2P mode**: `_team/members.json` (TeamManifest) — synced via iroh-docs
- **OSS mode**: `_team/members.json` uploaded to S3 bucket — synced via Loro CRDT

Both modes use the same JSON structure:

```json
{
  "owner_node_id": "abc123...",
  "members": [
    {
      "node_id": "abc123...",
      "name": "Alice",
      "role": "owner",
      "label": "Team Lead",
      "platform": "macos",
      "arch": "aarch64",
      "hostname": "alice-mbp",
      "added_at": "2026-03-23T10:00:00Z"
    }
  ]
}
```

## Unified Flow

### 1. Owner Creates Team

**Input:** Team name, sync mode (OSS or P2P), owner info

**Backend:**
- Initialize sync infrastructure (S3 bucket or Iroh doc)
- Generate device NodeId via `get_device_info()`
- Auto-add owner as first member with `Owner` role
- Generate ticket:
  - OSS: `team_secret` (existing mechanism)
  - P2P: `DocTicket` (existing mechanism)

**Output:** team_id (OSS) + ticket for sharing

### 2. Owner Adds Members

**Input:** name, NodeId, label, role (editor/viewer)

**Validation:**
- NodeId format check (valid hex string)
- No duplicate NodeId in existing members
- Cannot add another Owner (only one owner allowed)

**Backend:**
- Append to members manifest
- Persist: P2P → `_team/members.json` in iroh-docs, OSS → upload to S3

### 3. Member Joins Team

**Input:** ticket (+ team_id for OSS)

**Validation (two-step):**

1. **Ticket validation:**
   - OSS: verify team_id + team_secret against server
   - P2P: attempt to import DocTicket
   - Failure → error: "Ticket 不正确，请检查后重试"

2. **NodeId validation:**
   - Get local device NodeId via `get_device_info()`
   - Download/sync members manifest
   - Check if local NodeId exists in manifest
   - Not found → error: "你的设备未被添加到团队中，请联系团队 Owner"
   - Found → proceed with join, set local role from manifest

**On success:**
- Save team config locally
- Start sync based on mode
- Set local user's role from manifest

### 4. Member List UI

**Location:** Settings → Team section (existing location)

**Components:**

```
┌─────────────────────────────────────────┐
│ Team Members                    [+ Add] │  ← Add button visible for Owner/Editor
├─────────────────────────────────────────┤
│ 👤 Alice (Owner)         abc1...23ef    │
│    Team Lead                            │
├─────────────────────────────────────────┤
│ 👤 Bob (Editor)          def4...56gh    │  ← hover shows edit/remove for Owner/Editor
│    Backend Developer            [⋮]    │
├─────────────────────────────────────────┤
│ 👤 Charlie (Viewer)      ghi7...89ij    │
│    Designer                     [⋮]    │
└─────────────────────────────────────────┘
```

**Behavior by role:**
- Owner/Editor: see Add button, context menu (edit role, remove member) on each row
- Viewer: read-only, no action buttons
- Owner cannot be removed or demoted by Editor

## Unified Tauri Commands

Abstract over sync mode with unified command interfaces:

```rust
// Unified commands (dispatch to OSS or P2P internally based on active mode)
#[tauri::command]
async fn team_create(mode: TeamSyncMode, name: String, ...) -> Result<TeamCreateResult>

#[tauri::command]
async fn team_join(mode: TeamSyncMode, ticket: String, team_id: Option<String>) -> Result<TeamJoinResult>

#[tauri::command]
async fn team_add_member(member: TeamMember) -> Result<()>

#[tauri::command]
async fn team_remove_member(node_id: String) -> Result<()>

#[tauri::command]
async fn team_update_member_role(node_id: String, role: MemberRole) -> Result<()>

#[tauri::command]
async fn team_get_members() -> Result<Vec<TeamMember>>

#[tauri::command]
async fn get_device_info() -> Result<DeviceInfo>  // Already exists
```

**Return types:**

```rust
pub struct TeamCreateResult {
    pub team_id: Option<String>,  // OSS only
    pub ticket: String,           // DocTicket or team_secret
}

pub struct TeamJoinResult {
    pub success: bool,
    pub role: MemberRole,
    pub members: Vec<TeamMember>,
}

pub enum TeamJoinError {
    InvalidTicket,                // Ticket verification failed
    DeviceNotRegistered,          // NodeId not in allowlist
    AlreadyInTeam,                // Already a member
    SyncError(String),            // Infrastructure error
}
```

## Changes Required

### Rust Backend

1. **New file: `src-tauri/src/commands/team_unified.rs`**
   - Unified command handlers that dispatch to OSS or P2P backends
   - Shared `TeamMember`, `MemberRole` types (move from team_p2p.rs)

2. **Modify `oss_sync.rs`:**
   - Add NodeId support: call `get_device_info()` to get local NodeId
   - Add members manifest management (upload/download `_team/members.json` to S3)
   - Add NodeId validation on join
   - Replace `TeamRole::Owner | Member` with unified `MemberRole::Owner | Editor | Viewer`

3. **Modify `team_p2p.rs`:**
   - Import shared `TeamMember` / `MemberRole` from unified module
   - Ensure join flow checks NodeId against manifest before allowing sync
   - No major structural changes needed (P2P already has most of this)

4. **Modify `team.rs`:**
   - Update `check_team_status()` to return unified role info

### React Frontend

1. **Modify `lib/git/types.ts`:**
   - Unify `TeamMember` type (already close to P2P version)
   - Add `TeamCreateResult`, `TeamJoinResult`, `TeamJoinError` types

2. **Modify `components/settings/team/TeamOSSConfig.tsx`:**
   - Use unified create/join flow with NodeId validation
   - Show proper error messages for two-step validation

3. **Modify `components/settings/team/TeamP2PConfig.tsx`:**
   - Use unified create/join flow
   - Align UI with OSS version

4. **Modify `components/settings/TeamMemberList.tsx`:**
   - Accept current user's role as prop
   - Conditionally render add/edit/remove controls
   - Use unified `team_get_members` command

5. **Modify `components/settings/AddMemberInput.tsx`:**
   - Ensure role selector offers `Owner | Editor | Viewer`
   - Add label/remark field if not present

6. **Modify `components/settings/DeviceIdDisplay.tsx`:**
   - Ensure it works in both OSS and P2P contexts

## Error Handling

| Scenario | Error Message (zh) | Error Message (en) |
|---|---|---|
| Invalid ticket | Ticket 不正确，请检查后重试 | Invalid ticket, please check and try again |
| Device not registered | 你的设备未被添加到团队中，请联系团队 Owner | Your device has not been added to the team. Please contact the team Owner |
| Duplicate NodeId | 该设备已存在于团队中 | This device already exists in the team |
| Cannot remove Owner | 无法移除团队 Owner | Cannot remove the team Owner |
| Network/sync error | 同步失败：{detail} | Sync failed: {detail} |

## Testing

- Unit tests for NodeId validation logic
- Unit tests for role-based permission checks
- Integration tests for create → add member → join flow (both modes)
- UI tests for member list role-based rendering
- Error case tests: invalid ticket, unregistered device

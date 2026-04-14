# Collaborative Session v1 Design

**Date:** 2026-04-14
**Status:** Draft

## Problem

TeamClaw runs agents locally on each user's Desktop. When multiple team members need to work together with an AI agent, there's no shared conversation. Each person has their own isolated session. Team members without a Desktop (e.g., on mobile only) can't participate at all.

## Solution

Enable multi-person collaborative sessions on iOS, where multiple team members chat together and @Agent to trigger the AI. Agent runs on the session creator's paired Desktop. A lightweight login flow allows team members without a Desktop to join via invitation link.

### Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Session creation | iOS only (paired users) | Desktop doesn't need collab UI in v1 |
| Member addition | Direct add, no invite/accept | Simplicity — team members are trusted |
| Agent model | Single Agent on creator's Desktop | Simpler than multi-agent, v1 scope |
| Agent trigger | @Agent mention only | Most intuitive, avoids noise |
| Transport | MQTT session topics | Existing infrastructure, real-time |
| Offline messages | MQTT broker cache + Desktop pull | No OSS, Desktop is authority |
| Lightweight login | One-time invite URL | Secure, no permanent secrets exposed |
| Message types | Text only | v1 scope |

## User Types

| | Paired User | Lightweight User |
|---|---|---|
| Login | Scan QR to pair Desktop | Open invite link + set username |
| Personal sessions | ✅ | ❌ |
| Create collab | ✅ | ❌ (no paired Desktop for Agent) |
| Join collab | ✅ | ✅ |
| Send messages | ✅ | ✅ |
| @Agent | ✅ | ✅ |

## Design

### 1. Invitation Link & Lightweight Login

#### Link Generation

Any paired user (Desktop or iOS) can generate a one-time invite link from the team settings page.

```
teamclaw://join?ticket={one_time_token}&team={team_id}
```

- **One-time use**: Token invalidated after first use
- **24-hour expiry**: Token expires regardless of use
- **Storage**: Token stored in team config (OSS `_team/invites.json` or local manifest)
- **UI**: "Invite Member" button → generate link → copy/share sheet
- **Link list**: Show generated links with status (unused / used / expired)

#### Lightweight Login Flow

```
Open invite link on iOS
  → App launches (or App Store if not installed)
  → Validate token (check: exists, unused, not expired)
  → Set username screen
  → Save credentials locally: team_id, node_id (generated), username
  → Connect to team MQTT broker
  → Enter app: show collab sessions only (no personal session tab)
```

MQTT credentials for lightweight users: use the same team MQTT broker credentials (team_id based auth). The lightweight user gets a generated `node_id` for identity.

#### Username Setting

All users (paired + lightweight) can set/edit their username in iOS Settings. Username is:
- Stored locally on device
- Included as `sender_name` in all MQTT messages
- Synced to team members manifest

### 2. MQTT Topic Structure

#### Existing (unchanged)

```
teamclaw/{team_id}/{device_id}/chat/req    ← iOS→Desktop single-user chat
teamclaw/{team_id}/{device_id}/chat/res    ← Desktop→iOS single-user reply
teamclaw/{team_id}/{device_id}/status      ← Device online status
```

#### New

```
teamclaw/{team_id}/user/{node_id}/inbox    ← Personal notifications (collab create)
teamclaw/{team_id}/session/{session_id}    ← Collaborative session messages
```

#### Subscription Rules

| Event | Action |
|-------|--------|
| iOS user joins team | Subscribe to `user/{node_id}/inbox` |
| Collab session created (member) | Receive `CollabControl(CREATE)` on inbox → subscribe `session/{id}` |
| Collab session created (creator) | Subscribe `session/{id}` |
| Desktop is Agent host | Receive `CollabControl(CREATE)` → subscribe `session/{id}` |
| Participant leaves | Unsubscribe `session/{id}` |
| Session ends | All participants unsubscribe `session/{id}` |
| App startup | Re-subscribe all active collab sessions from local storage |

### 3. Protobuf Extensions

Extend existing `teamclaw.proto`. No changes to existing fields.

#### Extend ChatRequest

```protobuf
message ChatRequest {
  // Existing fields unchanged
  string session_id = 1;
  string content = 2;
  optional string image_url = 3;
  optional string model = 4;

  // New: collaboration sender info
  optional string sender_id = 10;
  optional string sender_name = 11;
  optional string sender_type = 12;    // "human" | "agent"
}
```

Used for both human messages and Agent complete replies. Agent streaming (`ChatResponse`) is NOT broadcast — only the final complete reply is sent as `ChatRequest(sender_type=agent)`.

#### New: CollabControl

```protobuf
message CollabControl {
  CollabControlType type = 1;
  string sender_id = 2;
  string sender_name = 3;
  optional string session_id = 4;
  repeated CollabMember members = 5;
  optional string agent_host_device = 6;
}

enum CollabControlType {
  COLLAB_CREATE = 0;
  COLLAB_LEAVE = 1;
  COLLAB_END = 2;
}

message CollabMember {
  string node_id = 1;
  string name = 2;
}
```

#### Extend MqttMessage Envelope

```protobuf
message MqttMessage {
  // ... existing oneof payload ...

  // New: collaboration
  CollabControl collab_control = 20;
}
```

### 4. Collaborative Session Lifecycle

#### Create (iOS, paired user only)

1. User taps "New Collab Session" → selects team members from member list
2. Generate `session_id` (UUID)
3. Publish `CollabControl(CREATE)` to each member's inbox topic: `user/{member_node_id}/inbox`
4. Publish `CollabControl(CREATE)` to creator's paired Desktop device topic (to notify Agent host)
5. Creator subscribes to `session/{session_id}`
6. Creator's Desktop receives CREATE → subscribes to `session/{session_id}` → creates OpenCode session

#### Join (auto, on receiving CREATE)

1. iOS receives `CollabControl(CREATE)` on inbox
2. Auto-subscribe to `session/{session_id}`
3. Session appears in collab sessions list
4. If joining late (app was offline): on subscribe, pull history from Desktop via `MessageSyncRequest`

#### Chat

1. User types message → publish `ChatRequest` to `session/{session_id}`
   - `sender_id` = user's node_id
   - `sender_name` = username
   - `sender_type` = "human"
2. All subscribers (other iOS + Desktop) receive the message
3. Desktop processes:
   - Contains `@Agent` → `session.prompt(parts)` → Agent responds → publish complete reply as `ChatRequest(sender_type=agent)`
   - No `@Agent` → `session.prompt(parts, noReply=true)` → silent context injection

#### @Agent Detection

Simple text matching: message content contains `@Agent` (case-insensitive). No @ picker UI in v1 — user just types `@Agent`.

Content sent to OpenCode is prefixed with sender identity:
```
[张三] @Agent 帮我分析一下这个方案的可行性
```

System prompt for collab sessions:
```
你是一个团队协作助手。当前协作成员：{member_names}。
当有人 @Agent 时你需要回复。消息格式：[姓名] 内容。
```

#### Leave (participant)

1. User taps "Leave" in session menu
2. Publish `CollabControl(LEAVE)` to `session/{session_id}`
3. Unsubscribe from session topic
4. Remove session from local list
5. Other participants see "[xxx] left the session"

#### End (creator only)

1. Creator taps "End Collaboration" in session menu
2. Publish `CollabControl(END)` to `session/{session_id}`
3. All participants receive END → unsubscribe → session marked as ended
4. Desktop unsubscribes → session remains in OpenCode (history preserved)

### 5. Desktop Changes (Rust MQTT Relay)

Desktop has **no UI changes**. All changes are in the MQTT relay layer.

#### New: Session Topic Subscription

When Desktop receives `CollabControl(CREATE)` where it's the Agent host:
- Subscribe to `session/{session_id}`
- Create OpenCode session with collab system prompt
- Track session_id → opencode_session_id mapping

#### New: Collab Message Handler

For each `ChatRequest` received on a session topic:
- If `sender_type == "agent"` → ignore (it's our own broadcast)
- If content contains `@Agent`:
  - Strip the @Agent marker
  - Format: `[{sender_name}] {content}`
  - Call `prompt_async` (normal, Agent will respond)
  - On complete: publish `ChatRequest(sender_type=agent, content=reply)` to session topic
- If no `@Agent`:
  - Format: `[{sender_name}] {content}`
  - Call `prompt_async` with `noReply=true`

#### noReply Implementation

Check if OpenCode's `/session/{id}/prompt_async` supports a `noReply` body parameter. If not, implement by:
1. Adding `noReply` support to the HTTP API call
2. Or using a convention: send message but immediately cancel the response stream

#### History Pull

Extend existing `MessageSyncRequest` handler to support collab session_id. The response includes all messages with `sender_id`/`sender_name` so iOS can render multi-person history.

### 6. iOS Changes

#### 6a. Lightweight Login

- New screen: `InviteLinkHandler` — deep link handler for `teamclaw://join?...`
- New screen: `SetUsernameView` — username input after token validation
- New state: `AuthState` gains `.lightweightUser(teamId, nodeId, username)` variant
- Lightweight user connects to MQTT with team credentials, subscribes to personal inbox

#### 6b. Invite Link Generation

- Team Settings → "Invite Member" button
- Calls API to generate token (FC endpoint or local generation + sync to manifest)
- Shows generated link with copy/share actions
- List of generated invites with status

#### 6c. Collab Session Creation

- New Session Sheet → "Collaborative Session" option (paired users only)
- Member picker from team member list (including lightweight users)
- On create: publish `CollabControl(CREATE)` to each member's inbox + own Desktop

#### 6d. Collab Chat UI

Extend existing `ChatDetailView`:

- **My messages**: right side bubble (same as current)
- **Other humans**: left side bubble + `sender_name` label above bubble
- **Agent replies**: left side, Agent style with bot icon (same as current)
- **System messages**: centered, gray text ("[xxx] joined", "[xxx] left", "Collaboration ended")
- **Top bar**: session name + participant count, tap to see member list
- **Input**: standard text input, user types `@Agent` manually
- **Menu**: "Leave" for participants, "End Collaboration" for creator

#### 6e. Session List

- Collab sessions shown with group icon + participant count
- Lightweight users: only see collab sessions tab
- Paired users: see both personal and collab sessions

#### 6f. Username Setting

- Settings → Profile → Username field
- Editable by all users
- Persisted locally + synced

### 7. Offline & Late Join

| Scenario | Handling |
|----------|----------|
| Short offline (< broker cache) | MQTT broker auto-delivers cached messages on reconnect |
| Long offline | On reconnect, send `MessageSyncRequest` to Desktop for full session history |
| Late join (new member added later) | Same as long offline — pull full history from Desktop |
| Desktop offline | Collab chat continues (human-to-human), Agent unavailable. When Desktop comes back, it pulls messages from MQTT broker cache and injects into OpenCode |

**Prerequisite**: Creator's Desktop must be online for Agent to work. If Desktop goes offline, human chat continues but @Agent gets no response until Desktop reconnects.

### 8. Security

- Invite tokens: one-time use + 24h expiry, stored in team manifest
- MQTT auth: team-level credentials (existing broker auth)
- Lightweight users can only access collab sessions, not other team data
- No secrets in protobuf messages (tokens only used during login, never in chat)

## Scope

### In Scope
- Invite link generation (Desktop + iOS paired users)
- Lightweight login flow on iOS
- Username setting on iOS
- Collab session creation on iOS (paired users)
- Multi-person text chat via MQTT session topics
- @Agent mention trigger with noReply context injection
- Agent reply broadcast
- Leave / End session lifecycle
- Offline message recovery from Desktop
- Protobuf extensions (ChatRequest sender fields, CollabControl)
- Desktop MQTT relay for collab sessions

### Out of Scope (v1)
- Desktop collab UI
- Image / file messages
- Typing indicators / online presence
- Kick member
- `all` / `owner_only` trigger modes
- Convert existing session to collab
- Tool call approval from collaborators
- @ picker UI (just type @Agent)
- Multi-Agent mode

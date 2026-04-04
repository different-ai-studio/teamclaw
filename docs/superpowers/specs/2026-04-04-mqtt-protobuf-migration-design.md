# MQTT Protocol: JSON to Protobuf Migration

## Overview

Migrate all MQTT message serialization from JSON to Protocol Buffers (protobuf) across the TeamClaw project. This includes the iOS client (Swift), Desktop relay (Rust/Tauri), and the pairing handshake. The migration also unifies the inconsistent request patterns (/commands raw text vs JSON envelope) into a single protobuf envelope with `oneof` payload, adds pagination to list endpoints, and optimizes the chat streaming design.

## Goals

- Reduce MQTT payload size via binary protobuf encoding
- Single source of truth for message schema (`proto/teamclaw.proto`)
- Unify request/response patterns (eliminate /commands raw text and JSON envelope split)
- Add pagination for large list responses
- Improve chat streaming (error handling, cancel support, drop redundant `full` field)

## Non-Goals

- Changing MQTT topic structure (stays as `teamclaw/{team_id}/{device_id}/{subtopic}`)
- Changing QoS levels (stays QoS 1 everywhere)
- Backward compatibility (breaking change, both sides update simultaneously)

---

## Proto Schema

**File:** `proto/teamclaw.proto`

```protobuf
syntax = "proto3";
package teamclaw;

// ═══════════════════════════════════════
// Common
// ═══════════════════════════════════════

message PageRequest {
  int32 page = 1;       // 1-based
  int32 page_size = 2;  // default 50
}

message PageInfo {
  int32 page = 1;
  int32 page_size = 2;
  int32 total = 3;
}

// ═══════════════════════════════════════
// Unified Envelope
// ═══════════════════════════════════════

message MqttMessage {
  string id = 1;
  double timestamp = 2;
  oneof payload {
    // Chat
    ChatRequest chat_request = 10;
    ChatResponse chat_response = 11;
    ChatCancel chat_cancel = 12;

    // Status
    StatusReport status_report = 20;

    // Sessions
    SessionSyncRequest session_sync_request = 30;
    SessionSyncResponse session_sync_response = 31;

    // Members
    MemberSyncRequest member_sync_request = 40;
    MemberSyncResponse member_sync_response = 41;

    // Skills
    SkillSyncRequest skill_sync_request = 50;
    SkillSyncResponse skill_sync_response = 51;

    // Talents
    TalentSyncRequest talent_sync_request = 60;
    TalentSyncResponse talent_sync_response = 61;

    // Automations
    AutomationSyncRequest automation_sync_request = 70;
    AutomationSyncResponse automation_sync_response = 71;

    // Task status push
    TaskUpdate task_update = 80;

    // Pairing
    PairingDiscovery pairing_discovery = 90;
    PairingRequest pairing_request = 91;
    PairingResponse pairing_response = 92;
  }
}

// ═══════════════════════════════════════
// Chat
// ═══════════════════════════════════════

message ChatRequest {
  string session_id = 1;
  string content = 2;
  optional string image_url = 3;
  optional string model = 4;
}

message ChatResponse {
  string session_id = 1;
  int32 seq = 2;
  oneof event {
    string delta = 10;
    StreamDone done = 11;
    StreamError error = 12;
  }
}

message StreamDone {}

message StreamError {
  string message = 1;
}

message ChatCancel {
  string session_id = 1;
}

// ═══════════════════════════════════════
// Status
// ═══════════════════════════════════════

message StatusReport {
  bool online = 1;
  optional string device_name = 2;
}

// ═══════════════════════════════════════
// Sessions
// ═══════════════════════════════════════

message SessionSyncRequest {
  PageRequest pagination = 1;
}

message SessionSyncResponse {
  repeated SessionData sessions = 1;
  PageInfo pagination = 2;
}

message SessionData {
  string id = 1;
  string title = 2;
  int64 updated = 3;
}

// ═══════════════════════════════════════
// Members
// ═══════════════════════════════════════

message MemberSyncRequest {
  PageRequest pagination = 1;
}

message MemberSyncResponse {
  repeated MemberData members = 1;
  PageInfo pagination = 2;
}

message MemberData {
  string id = 1;
  string name = 2;
  string avatar_url = 3;
  optional string department = 4;
  bool is_ai_ally = 5;
  string note = 6;
}

// ═══════════════════════════════════════
// Skills
// ═══════════════════════════════════════

message SkillSyncRequest {
  PageRequest pagination = 1;
}

message SkillSyncResponse {
  repeated SkillData skills = 1;
  PageInfo pagination = 2;
}

message SkillData {
  string id = 1;
  string name = 2;
  string description = 3;
  bool is_personal = 4;
  bool is_enabled = 5;
}

// ═══════════════════════════════════════
// Talents
// ═══════════════════════════════════════

message TalentSyncRequest {
  PageRequest pagination = 1;
}

message TalentSyncResponse {
  repeated TalentData talents = 1;
  PageInfo pagination = 2;
}

message TalentData {
  string id = 1;
  string name = 2;
  string description = 3;
  string category = 4;
  optional string icon = 5;
  int32 downloads = 6;
}

// ═══════════════════════════════════════
// Automations
// ═══════════════════════════════════════

message AutomationSyncRequest {
  PageRequest pagination = 1;
}

message AutomationSyncResponse {
  repeated AutomationTaskData tasks = 1;
  PageInfo pagination = 2;
}

message AutomationTaskData {
  string id = 1;
  string name = 2;
  optional string status = 3;
  string cron_expression = 4;
  string description = 5;
  optional double last_run_time = 6;
}

// ═══════════════════════════════════════
// Task Update (server push)
// ═══════════════════════════════════════

message TaskUpdate {
  string task_id = 1;
  string status = 2;
  optional double last_run_time = 3;
}

// ═══════════════════════════════════════
// Pairing
// ═══════════════════════════════════════

// Desktop publishes on `teamclaw/pairing/{code}` (retained)
message PairingDiscovery {
  string team_id = 1;
  string device_id = 2;
  string device_name = 3;
}

// Mobile publishes on `teamclaw/pairing/{code}`
message PairingRequest {
  string device_id = 1;
  string device_name = 2;
}

// Desktop responds on `teamclaw/pairing/{code}`
message PairingResponse {
  string mqtt_host = 1;
  uint32 mqtt_port = 2;
  string mqtt_username = 3;
  string mqtt_password = 4;
  string team_id = 5;
  string desktop_device_id = 6;
  string desktop_device_name = 7;
}
```

---

## Code Generation

### Shared

- Proto file location: `proto/teamclaw.proto`
- Both platforms generate code from the same `.proto` file

### Rust (Desktop Relay)

- **Tool:** `prost` + `prost-build`
- **Config:** `src-tauri/build.rs` runs `prost_build::compile_protos()`
- **Output:** Generated Rust structs in `src-tauri/src/proto/teamclaw.rs`
- **Usage:** `include!(concat!(env!("OUT_DIR"), "/teamclaw.rs"))` or explicit module

### iOS (Swift Client)

- **Tool:** `swift-protobuf` via SPM
- **Config:** `protoc --swift_out=` or SwiftProtobuf plugin
- **Output:** `TeamClawMobile/TeamClawMobile/Generated/Teamclaw.pb.swift`
- **Dependency:** Add `apple/swift-protobuf` to Xcode SPM dependencies

---

## What Changes

### Eliminated

- `MQTTMessageType` enum (replaced by `oneof` in protobuf)
- All hand-written `Codable` structs in `MQTTMessage.swift`
- All `serde_json` structs in `mqtt_config.rs`
- `/commands` raw text pattern (`/members`, `/skills`, etc.)
- `publishRaw()` calls for commands
- `ChatResponse.full` field (client aggregates deltas)
- `sessionListRequest` as special-case JSON envelope

### Added

- `proto/teamclaw.proto` (single schema file)
- `Teamclaw.pb.swift` (generated, not checked in)
- `teamclaw.rs` (generated, not checked in)
- `ChatCancel` message (cancel streaming)
- `StreamError` message (error during generation)
- `PageRequest` / `PageInfo` (pagination for list endpoints)
- Pairing messages (`PairingDiscovery`, `PairingRequest`, `PairingResponse`)
- Auto-pagination logic in iOS ViewModels (fetch all pages sequentially)

### Modified

#### iOS (`TeamClawMobile/`)

| File | Change |
|------|--------|
| `MQTTMessage.swift` | Delete entirely, replaced by generated `Teamclaw.pb.swift` |
| `MQTTService.swift` | Publish/receive binary `Data` instead of JSON strings |
| `MQTTServiceProtocol.swift` | `publish()` accepts `MqttMessage` (protobuf), remove `publishRaw()` |
| `MemberViewModel.swift` | Use `Teamclaw_MemberSyncRequest/Response`, add pagination loop |
| `SkillViewModel.swift` | Use `Teamclaw_SkillSyncRequest/Response`, add pagination loop |
| `TalentViewModel.swift` | Use `Teamclaw_TalentSyncRequest/Response`, add pagination loop |
| `TaskViewModel.swift` | Use `Teamclaw_AutomationSyncRequest/Response`, add pagination loop |
| `SessionListViewModel.swift` | Use `Teamclaw_SessionSyncRequest/Response`, add pagination loop |
| `ChatDetailViewModel.swift` | Handle `StreamDone`/`StreamError` events, support `ChatCancel` |
| `PairingManager.swift` | Use `PairingDiscovery`/`PairingRequest`/`PairingResponse` protobuf messages |
| `MockMQTTService.swift` | Update to match new protocol interface |

#### Rust (`src-tauri/`)

| File | Change |
|------|--------|
| `build.rs` | Add `prost-build` compilation step |
| `Cargo.toml` | Add `prost`, `prost-build` dependencies |
| `mqtt_config.rs` | Delete JSON structs, import generated protobuf types |
| `mqtt_relay.rs` | Deserialize with `MqttMessage::decode()`, match on `oneof payload`, serialize responses with `.encode()`, remove /command string matching, add pagination support, handle `ChatCancel` |

---

## Message Flow Changes

### Before (JSON + /commands)

```
Mobile: publishRaw("/members")          → raw text on chat/req topic
Desktop: parse string, match /command   → JSON MqttMessage on member topic
Mobile: JSON decode MemberSyncPayload
```

### After (protobuf)

```
Mobile: MqttMessage { member_sync_request { pagination { page:1 page_size:50 } } }
        → binary protobuf on chat/req topic
Desktop: MqttMessage::decode(), match oneof payload
        → MqttMessage { member_sync_response { members:[...] pagination:{...} } }
        → binary protobuf on member topic
Mobile: MqttMessage(serializedBytes:), switch oneof payload
```

### Chat Streaming (optimized)

```
Mobile sends:  MqttMessage { chat_request { session_id, content } }
Desktop sends: MqttMessage { chat_response { seq:0, delta:"AI " } }
Desktop sends: MqttMessage { chat_response { seq:1, delta:"is " } }
Desktop sends: MqttMessage { chat_response { seq:2, done:{} } }

On error:      MqttMessage { chat_response { seq:3, error:{ message:"rate limited" } } }
On cancel:     MqttMessage { chat_cancel { session_id } }  (Mobile → Desktop)
```

### Pagination Flow

```
Mobile sends:  MqttMessage { member_sync_request { pagination { page:1 page_size:50 } } }
Desktop sends: MqttMessage { member_sync_response { members:[50 items] pagination { page:1 page_size:50 total:120 } } }
Mobile sees total > page*page_size, sends next page automatically
Mobile sends:  MqttMessage { member_sync_request { pagination { page:2 page_size:50 } } }
Desktop sends: MqttMessage { member_sync_response { members:[50 items] pagination { page:2 page_size:50 total:120 } } }
Mobile sends:  MqttMessage { member_sync_request { pagination { page:3 page_size:50 } } }
Desktop sends: MqttMessage { member_sync_response { members:[20 items] pagination { page:3 page_size:50 total:120 } } }
Mobile: all pages received, replace SwiftData, update UI
```

### Pairing Handshake

```
Desktop publishes (retained):
  Topic: teamclaw/pairing/{code}
  MqttMessage { pairing_discovery { team_id, device_id, device_name } }

Mobile subscribes, receives discovery, publishes:
  Topic: teamclaw/pairing/{code}
  MqttMessage { pairing_request { device_id, device_name } }

Desktop responds:
  Topic: teamclaw/pairing/{code}
  MqttMessage { pairing_response { mqtt_host, mqtt_port, mqtt_username, mqtt_password, ... } }
```

---

## Topic Structure (unchanged)

| Topic | Direction | Content |
|-------|-----------|---------|
| `teamclaw/{team_id}/{mobile_id}/chat/req` | M→D | ChatRequest, ChatCancel, all SyncRequests |
| `teamclaw/{team_id}/{mobile_id}/chat/res` | D→M | ChatResponse, SessionSyncResponse |
| `teamclaw/{team_id}/{desktop_id}/status` | D→M | StatusReport (retained) |
| `teamclaw/{team_id}/{mobile_id}/member` | D→M | MemberSyncResponse |
| `teamclaw/{team_id}/{mobile_id}/skill` | D→M | SkillSyncResponse |
| `teamclaw/{team_id}/{mobile_id}/task` | D→M | AutomationSyncResponse, TaskUpdate |
| `teamclaw/{team_id}/{mobile_id}/talent` | D→M | TalentSyncResponse |
| `teamclaw/pairing/{code}` | Both | PairingDiscovery, PairingRequest, PairingResponse |

All payloads are binary protobuf-encoded `MqttMessage`.

---

## Testing

- Update `MQTTMessageTests.swift` to test protobuf encode/decode round-trips
- Update Rust E2E tests (`tests/mqtt-e2e/`) to use protobuf
- Verify pagination with mock data sets > 50 items
- Test ChatCancel and StreamError paths
- Test pairing handshake with protobuf messages

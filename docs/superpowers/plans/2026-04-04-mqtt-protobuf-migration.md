# MQTT Protobuf Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all JSON serialization in the MQTT protocol with protobuf, unify request/response patterns, add pagination, and optimize chat streaming.

**Architecture:** Single `proto/teamclaw.proto` schema generates code for both platforms — Rust (`prost`) and Swift (`swift-protobuf`). The unified `MqttMessage` envelope with `oneof payload` replaces the current `MQTTMessageType` enum + hand-written Codable/serde structs. Sessions are created implicitly by the first `ChatRequest` — no explicit create message.

**Tech Stack:** protobuf3, prost + prost-build (Rust), swift-protobuf (iOS/SPM), CocoaMQTT5, rumqttc

---

## File Map

### New Files
| File | Purpose |
|------|---------|
| `proto/teamclaw.proto` | Single source of truth for all message types |
| `TeamClawMobile/TeamClawMobile/Core/MQTT/ProtoMQTTCoder.swift` | Encode/decode helper wrapping protobuf binary ↔ MqttMessage |

### Modified Files
| File | Change |
|------|--------|
| `src-tauri/build.rs` | Add prost-build compilation step |
| `src-tauri/Cargo.toml` | Add prost, prost-build, prost-types deps |
| `src-tauri/src/commands/gateway/mqtt_config.rs` | Delete JSON payload structs, add `pub mod proto` with generated types |
| `src-tauri/src/commands/gateway/mqtt_relay.rs` | Binary decode/encode, match oneof, pagination, ChatCancel, StreamError |
| `TeamClawMobile/TeamClawMobile/Core/MQTT/MQTTMessage.swift` | Delete entirely (replaced by generated Teamclaw.pb.swift) |
| `TeamClawMobile/TeamClawMobile/Core/MQTT/MQTTServiceProtocol.swift` | Remove `publishRaw`, change `publish` to accept binary Data |
| `TeamClawMobile/TeamClawMobile/Core/MQTT/MQTTService.swift` | Publish/receive binary Data, decode protobuf |
| `TeamClawMobile/TeamClawMobile/Core/MQTT/MockMQTTService.swift` | Match new protocol interface |
| `TeamClawMobile/TeamClawMobile/Core/MessageAggregator.swift` | Accept protobuf ChatResponse instead of ChatResponsePayload |
| `TeamClawMobile/TeamClawMobile/Core/PairingManager.swift` | Use protobuf PairingDiscovery/Request/Response |
| `TeamClawMobile/TeamClawMobile/Features/Chat/ChatDetailViewModel.swift` | Protobuf ChatRequest/Response, handle StreamDone/StreamError/ChatCancel |
| `TeamClawMobile/TeamClawMobile/Features/SessionList/SessionListViewModel.swift` | Protobuf SessionSyncRequest/Response with pagination |
| `TeamClawMobile/TeamClawMobile/Features/TeamMembers/MemberViewModel.swift` | Protobuf MemberSyncRequest/Response with pagination |
| `TeamClawMobile/TeamClawMobile/Features/Skills/SkillViewModel.swift` | Protobuf SkillSyncRequest/Response with pagination |
| `TeamClawMobile/TeamClawMobile/Features/TeamMembers/TalentViewModel.swift` | Protobuf TalentSyncRequest/Response with pagination |
| `TeamClawMobile/TeamClawMobile/Features/Automation/TaskViewModel.swift` | Protobuf AutomationSyncRequest/Response with pagination, TaskUpdate |
| `TeamClawMobile/TeamClawMobileTests/Core/MQTTMessageTests.swift` | Rewrite for protobuf encode/decode round-trips |
| `TeamClawMobile/TeamClawMobileTests/Core/MessageAggregatorTests.swift` | Update for new ChatResponse protobuf type |

### Deleted Files
| File | Reason |
|------|--------|
| `TeamClawMobile/TeamClawMobile/Core/MQTT/MQTTMessage.swift` | Replaced by generated `Teamclaw.pb.swift` |

---

## Task 1: Create proto/teamclaw.proto

**Files:**
- Create: `proto/teamclaw.proto`

- [ ] **Step 1: Create the proto file**

```protobuf
syntax = "proto3";
package teamclaw;

// ─── Common ───

message PageRequest {
  int32 page = 1;
  int32 page_size = 2;
}

message PageInfo {
  int32 page = 1;
  int32 page_size = 2;
  int32 total = 3;
}

// ─── Unified Envelope ───

message MqttMessage {
  string id = 1;
  double timestamp = 2;
  oneof payload {
    ChatRequest chat_request = 10;
    ChatResponse chat_response = 11;
    ChatCancel chat_cancel = 12;
    StatusReport status_report = 20;
    SessionSyncRequest session_sync_request = 30;
    SessionSyncResponse session_sync_response = 31;
    MemberSyncRequest member_sync_request = 40;
    MemberSyncResponse member_sync_response = 41;
    SkillSyncRequest skill_sync_request = 50;
    SkillSyncResponse skill_sync_response = 51;
    TalentSyncRequest talent_sync_request = 60;
    TalentSyncResponse talent_sync_response = 61;
    AutomationSyncRequest automation_sync_request = 70;
    AutomationSyncResponse automation_sync_response = 71;
    TaskUpdate task_update = 80;
    PairingDiscovery pairing_discovery = 90;
    PairingRequest pairing_request = 91;
    PairingResponse pairing_response = 92;
  }
}

// ─── Chat ───

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

// ─── Status ───

message StatusReport {
  bool online = 1;
  optional string device_name = 2;
}

// ─── Sessions ───

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

// ─── Members ───

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

// ─── Skills ───

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

// ─── Talents ───

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

// ─── Automations ───

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

// ─── Task Update (server push) ───

message TaskUpdate {
  string task_id = 1;
  string status = 2;
  optional double last_run_time = 3;
}

// ─── Pairing ───

message PairingDiscovery {
  string team_id = 1;
  string device_id = 2;
  string device_name = 3;
}

message PairingRequest {
  string device_id = 1;
  string device_name = 2;
}

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

- [ ] **Step 2: Commit**

```bash
git add proto/teamclaw.proto
git commit -m "feat(proto): add teamclaw.proto schema for MQTT protobuf migration"
```

---

## Task 2: Rust — prost-build setup

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/build.rs`

- [ ] **Step 1: Add prost dependencies to Cargo.toml**

Add to `[dependencies]`:
```toml
prost = "0.13"
```

Add to `[build-dependencies]`:
```toml
prost-build = "0.13"
```

- [ ] **Step 2: Add proto compilation to build.rs**

Add before the `tauri_build::build()` call at the end of `build.rs`:

```rust
    // ── Compile protobuf ──
    let proto_path = root_dir.join("proto/teamclaw.proto");
    println!("cargo:rerun-if-changed={}", proto_path.display());
    prost_build::compile_protos(&[&proto_path], &[root_dir.join("proto")])
        .expect("Failed to compile teamclaw.proto");
```

- [ ] **Step 3: Verify Rust build compiles the proto**

```bash
cd src-tauri && cargo build 2>&1 | head -30
```

Expected: Build succeeds. Generated file appears in `target/debug/build/teamclaw-*/out/teamclaw.rs`.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/build.rs
git commit -m "build(rust): add prost-build for protobuf code generation"
```

---

## Task 3: Rust — Replace JSON structs with protobuf types in mqtt_config.rs

**Files:**
- Modify: `src-tauri/src/commands/gateway/mqtt_config.rs`

- [ ] **Step 1: Add proto module and remove JSON payload structs**

Keep `MqttConfig`, `PairedDevice`, `PairingSession`, `MqttRelayStatus` (these are Tauri config structs, not MQTT wire format). Delete `MqttMessageEnvelope`, `ChatRequestPayload`, `ChatResponsePayload`, `StatusPayload`, `TaskUpdatePayload`. Add at the top:

```rust
pub mod proto {
    include!(concat!(env!("OUT_DIR"), "/teamclaw.rs"));
}
```

- [ ] **Step 2: Verify build**

```bash
cd src-tauri && cargo check 2>&1 | tail -20
```

Expected: Errors in `mqtt_relay.rs` referencing deleted types — that's Task 4.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/gateway/mqtt_config.rs
git commit -m "refactor(rust): replace JSON payload structs with protobuf generated types"
```

---

## Task 4: Rust — Migrate mqtt_relay.rs to protobuf

**Files:**
- Modify: `src-tauri/src/commands/gateway/mqtt_relay.rs`

This is the largest task. The relay must:
1. Decode incoming messages with `MqttMessage::decode()` instead of `serde_json::from_slice()`
2. Match on `msg.payload` oneof variants instead of `envelope.msg_type` string
3. Encode responses with `.encode_to_vec()` instead of `serde_json::to_vec()`
4. Handle new types: `ChatCancel`, `StreamError`, pagination
5. Replace pairing JSON with protobuf

- [ ] **Step 1: Update imports**

Replace:
```rust
use super::mqtt_config::*;
```
With:
```rust
use super::mqtt_config::{MqttConfig, PairedDevice, PairingSession, MqttRelayStatus};
use super::mqtt_config::proto;
use prost::Message as ProstMessage;
```

- [ ] **Step 2: Update `publish_to_device` to accept bytes**

Change the helper that publishes to devices. Currently it serializes `MqttMessageEnvelope` to JSON. Change it to accept `proto::MqttMessage` and call `.encode_to_vec()`:

```rust
async fn publish_proto_to_device(&self, device_id: &str, subtopic: &str, msg: &proto::MqttMessage) -> Result<(), String> {
    let bytes = msg.encode_to_vec();
    let config = self.config.read().await;
    let topic = format!("teamclaw/{}/{}/{}", config.team_id, device_id, subtopic);
    if let Some(client) = self.client.lock().await.as_ref() {
        client.publish(topic, QoS::AtLeastOnce, false, bytes)
            .await
            .map_err(|e| format!("Publish failed: {}", e))?;
    }
    Ok(())
}
```

- [ ] **Step 3: Update `handle_incoming_message` to decode protobuf**

Replace JSON deserialization with:

```rust
async fn handle_incoming_message(&self, topic: &str, payload: &[u8]) -> Result<(), String> {
    let parts: Vec<&str> = topic.split('/').collect();

    let msg = proto::MqttMessage::decode(payload)
        .map_err(|e| format!("Protobuf decode failed: {}", e))?;

    let device_id = parts.get(2).map(|s| s.to_string());

    match msg.payload {
        Some(proto::mqtt_message::Payload::PairingRequest(ref req)) => {
            self.handle_pairing_request(&req.device_id, &req.device_name).await?;
        }
        Some(proto::mqtt_message::Payload::ChatRequest(ref req)) => {
            self.handle_chat_request_proto(topic, req).await?;
        }
        Some(proto::mqtt_message::Payload::ChatCancel(ref cancel)) => {
            self.handle_chat_cancel(&cancel.session_id).await;
        }
        Some(proto::mqtt_message::Payload::SessionSyncRequest(ref req)) => {
            if let Some(did) = device_id {
                self.handle_session_list_request_proto(&did, req).await?;
            }
        }
        Some(proto::mqtt_message::Payload::MemberSyncRequest(ref req)) => {
            if let Some(did) = device_id {
                self.handle_member_sync(&did, req).await?;
            }
        }
        Some(proto::mqtt_message::Payload::SkillSyncRequest(ref req)) => {
            if let Some(did) = device_id {
                self.handle_skill_sync(&did, req).await?;
            }
        }
        Some(proto::mqtt_message::Payload::TalentSyncRequest(ref req)) => {
            if let Some(did) = device_id {
                self.handle_talent_sync(&did, req).await?;
            }
        }
        Some(proto::mqtt_message::Payload::AutomationSyncRequest(ref req)) => {
            if let Some(did) = device_id {
                self.handle_automation_sync(&did, req).await?;
            }
        }
        _ => {
            eprintln!("[MQTT Relay] Unknown or empty payload");
        }
    }
    Ok(())
}
```

- [ ] **Step 4: Update chat response streaming to emit protobuf**

Update the SSE streaming handler. For each delta chunk, build:

```rust
fn build_chat_delta(session_id: &str, seq: i32, delta: &str) -> proto::MqttMessage {
    proto::MqttMessage {
        id: uuid::Uuid::new_v4().to_string(),
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64(),
        payload: Some(proto::mqtt_message::Payload::ChatResponse(proto::ChatResponse {
            session_id: session_id.to_string(),
            seq,
            event: Some(proto::chat_response::Event::Delta(delta.to_string())),
        })),
    }
}

fn build_chat_done(session_id: &str, seq: i32) -> proto::MqttMessage {
    proto::MqttMessage {
        id: uuid::Uuid::new_v4().to_string(),
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64(),
        payload: Some(proto::mqtt_message::Payload::ChatResponse(proto::ChatResponse {
            session_id: session_id.to_string(),
            seq,
            event: Some(proto::chat_response::Event::Done(proto::StreamDone {})),
        })),
    }
}

fn build_chat_error(session_id: &str, seq: i32, message: &str) -> proto::MqttMessage {
    proto::MqttMessage {
        id: uuid::Uuid::new_v4().to_string(),
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64(),
        payload: Some(proto::mqtt_message::Payload::ChatResponse(proto::ChatResponse {
            session_id: session_id.to_string(),
            seq,
            event: Some(proto::chat_response::Event::Error(proto::StreamError {
                message: message.to_string(),
            })),
        })),
    }
}
```

- [ ] **Step 5: Update pairing to use protobuf**

Replace JSON serialization in `generate_pairing_code()`:

```rust
let discovery = proto::MqttMessage {
    id: uuid::Uuid::new_v4().to_string(),
    timestamp: std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64(),
    payload: Some(proto::mqtt_message::Payload::PairingDiscovery(proto::PairingDiscovery {
        team_id: config.team_id.clone(),
        device_id: config.device_id.clone(),
        device_name: config.device_name.clone(),
    })),
};
let bytes = discovery.encode_to_vec();
// publish bytes (retained) to teamclaw/pairing/{code}
```

Replace JSON serialization in `handle_pairing_request()` response:

```rust
let response = proto::MqttMessage {
    id: uuid::Uuid::new_v4().to_string(),
    timestamp: std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64(),
    payload: Some(proto::mqtt_message::Payload::PairingResponse(proto::PairingResponse {
        mqtt_host: config.broker_host.clone(),
        mqtt_port: config.broker_port as u32,
        mqtt_username: new_device.mqtt_username.clone(),
        mqtt_password: new_device.mqtt_password.clone(),
        team_id: config.team_id.clone(),
        desktop_device_id: config.device_id.clone(),
        desktop_device_name: config.device_name.clone(),
    })),
};
```

- [ ] **Step 6: Add ChatCancel handler stub**

```rust
async fn handle_chat_cancel(&self, session_id: &str) {
    eprintln!("[MQTT Relay] Chat cancel requested for session: {}", session_id);
    // TODO: abort the running SSE stream for this session_id
    // For now, log it. Full cancellation requires tracking active streams.
}
```

- [ ] **Step 7: Verify Rust build**

```bash
cd src-tauri && cargo check 2>&1 | tail -20
```

Expected: Build succeeds with no errors.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/commands/gateway/mqtt_relay.rs
git commit -m "feat(rust): migrate mqtt_relay to protobuf encode/decode"
```

---

## Task 5: iOS — Add swift-protobuf dependency and generate code

**Files:**
- Modify: Xcode project (add SPM dependency)
- Create: `TeamClawMobile/TeamClawMobile/Generated/Teamclaw.pb.swift` (generated)

- [ ] **Step 1: Install protoc if not present**

```bash
brew install protobuf swift-protobuf
```

- [ ] **Step 2: Generate Swift protobuf code**

```bash
protoc --swift_out=TeamClawMobile/TeamClawMobile/Generated \
  --proto_path=proto \
  proto/teamclaw.proto
```

This generates `TeamClawMobile/TeamClawMobile/Generated/Teamclaw.pb.swift`.

- [ ] **Step 3: Add swift-protobuf SPM dependency to Xcode project**

In Xcode: File → Add Package Dependencies → `https://github.com/apple/swift-protobuf.git`, version 1.28.0+. Add `SwiftProtobuf` to the TeamClawMobile target.

Alternatively via Package.swift or manually editing the xcodeproj.

- [ ] **Step 4: Add Generated/Teamclaw.pb.swift to the Xcode project**

Add the generated file to the TeamClawMobile target in the Xcode project. Add to `project.pbxproj` in the appropriate PBXBuildFile, PBXFileReference, PBXGroup, and PBXSourcesBuildPhase sections.

- [ ] **Step 5: Verify the generated code compiles**

Build the project in Xcode or:
```bash
cd TeamClawMobile && xcodebuild -scheme TeamClawMobile -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 16' build 2>&1 | tail -20
```

- [ ] **Step 6: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/Generated/Teamclaw.pb.swift
git commit -m "feat(ios): add swift-protobuf dependency and generated code"
```

---

## Task 6: iOS — Create ProtoMQTTCoder helper

**Files:**
- Create: `TeamClawMobile/TeamClawMobile/Core/MQTT/ProtoMQTTCoder.swift`

- [ ] **Step 1: Write the helper**

```swift
import Foundation
import SwiftProtobuf

enum ProtoMQTTCoder {

    static func encode(_ message: Teamclaw_MqttMessage) -> Data? {
        try? message.serializedData()
    }

    static func decode(_ data: Data) -> Teamclaw_MqttMessage? {
        try? Teamclaw_MqttMessage(serializedBytes: data)
    }

    static func makeEnvelope(_ payload: Teamclaw_MqttMessage.OneOf_Payload) -> Teamclaw_MqttMessage {
        var msg = Teamclaw_MqttMessage()
        msg.id = UUID().uuidString
        msg.timestamp = Date().timeIntervalSince1970
        msg.payload = payload
        return msg
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/Core/MQTT/ProtoMQTTCoder.swift
git commit -m "feat(ios): add ProtoMQTTCoder helper for protobuf encode/decode"
```

---

## Task 7: iOS — Update MQTTServiceProtocol and MQTTService for binary

**Files:**
- Modify: `TeamClawMobile/TeamClawMobile/Core/MQTT/MQTTServiceProtocol.swift`
- Modify: `TeamClawMobile/TeamClawMobile/Core/MQTT/MQTTService.swift`
- Delete: `TeamClawMobile/TeamClawMobile/Core/MQTT/MQTTMessage.swift`

- [ ] **Step 1: Update MQTTServiceProtocol**

Replace entire file:

```swift
import Combine
import Foundation

protocol MQTTServiceProtocol: AnyObject {
    var isConnected: AnyPublisher<Bool, Never> { get }
    var receivedMessage: AnyPublisher<Teamclaw_MqttMessage, Never> { get }
    var receivedData: AnyPublisher<(topic: String, data: Data), Never> { get }
    func connect(host: String, port: UInt16, username: String, password: String)
    func disconnect()
    func subscribe(topic: String, qos: Int)
    func publish(topic: String, message: Teamclaw_MqttMessage, qos: Int)
}
```

- [ ] **Step 2: Update MQTTService**

Replace the publish/receive logic. Key changes:
- Remove `JSONDecoder`/`JSONEncoder`, `publishRaw`
- `publish` serializes protobuf to `Data` then sends binary
- `didReceiveMessage` reads raw bytes, decodes protobuf
- `receivedRaw` → `receivedData` (binary Data instead of String)

```swift
import Foundation
import Combine
import CocoaMQTT

final class MQTTService: NSObject, MQTTServiceProtocol {
    private var mqtt: CocoaMQTT5?
    private let connectedSubject = CurrentValueSubject<Bool, Never>(false)
    private let messageSubject = PassthroughSubject<Teamclaw_MqttMessage, Never>()
    private let dataSubject = PassthroughSubject<(topic: String, data: Data), Never>()

    var isConnected: AnyPublisher<Bool, Never> { connectedSubject.eraseToAnyPublisher() }
    var receivedMessage: AnyPublisher<Teamclaw_MqttMessage, Never> { messageSubject.eraseToAnyPublisher() }
    var receivedData: AnyPublisher<(topic: String, data: Data), Never> { dataSubject.eraseToAnyPublisher() }

    func connect(host: String, port: UInt16, username: String, password: String) {
        let clientID = "teamclaw-ios-\(UUID().uuidString.prefix(8))"
        let client = CocoaMQTT5(clientID: clientID, host: host, port: port)
        client.username = username
        client.password = password
        client.enableSSL = true
        client.allowUntrustCACertificate = true
        client.cleanSession = false
        client.keepAlive = 60
        client.autoReconnect = true
        client.autoReconnectTimeInterval = 5
        client.sslSettings = [kCFStreamSSLPeerName as String: host as NSString]
        client.didReceiveTrust = { _, _, completionHandler in completionHandler(true) }
        client.delegate = self
        mqtt = client
        _ = client.connect()
    }

    func disconnect() { mqtt?.disconnect() }

    func subscribe(topic: String, qos: Int) {
        let q: CocoaMQTTQoS = qos == 0 ? .qos0 : qos == 2 ? .qos2 : .qos1
        mqtt?.subscribe(topic, qos: q)
    }

    func publish(topic: String, message: Teamclaw_MqttMessage, qos: Int) {
        guard let data = ProtoMQTTCoder.encode(message) else { return }
        let q: CocoaMQTTQoS = qos == 0 ? .qos0 : qos == 2 ? .qos2 : .qos1
        let properties = MqttPublishProperties()
        mqtt?.publish(topic, withString: "", qos: q, DUP: false, retained: false, properties: properties)
        // CocoaMQTT5 needs binary publish — use the payload variant:
        mqtt?.publish(CocoaMQTT5Message(topic: topic, payload: [UInt8](data)), qos: q, DUP: false, retained: false, properties: properties)
    }
}

extension MQTTService: CocoaMQTT5Delegate {
    func mqtt5(_ mqtt5: CocoaMQTT5, didConnectAck ack: CocoaMQTTCONNACKReasonCode, connAckData: MqttDecodeConnAck?) {
        connectedSubject.send(ack == .success)
    }

    func mqtt5(_ mqtt5: CocoaMQTT5, didReceiveMessage message: CocoaMQTT5Message, id: UInt16, publishData: MqttDecodePublish?) {
        let data = Data(message.payload)
        dataSubject.send((topic: message.topic, data: data))
        if let msg = ProtoMQTTCoder.decode(data) {
            messageSubject.send(msg)
        }
    }

    func mqtt5DidDisconnect(_ mqtt5: CocoaMQTT5, withError err: Error?) { connectedSubject.send(false) }
    func mqtt5(_ mqtt5: CocoaMQTT5, didPublishMessage message: CocoaMQTT5Message, id: UInt16) {}
    func mqtt5(_ mqtt5: CocoaMQTT5, didPublishAck id: UInt16, pubAckData: MqttDecodePubAck?) {}
    func mqtt5(_ mqtt5: CocoaMQTT5, didPublishRec id: UInt16, pubRecData: MqttDecodePubRec?) {}
    func mqtt5(_ mqtt5: CocoaMQTT5, didSubscribeTopics success: NSDictionary, failed: [String], subAckData: MqttDecodeSubAck?) {}
    func mqtt5(_ mqtt5: CocoaMQTT5, didUnsubscribeTopics topics: [String], unsubAckData: MqttDecodeUnsubAck?) {}
    func mqtt5(_ mqtt5: CocoaMQTT5, didReceiveDisconnectReasonCode reasonCode: CocoaMQTTDISCONNECTReasonCode) {}
    func mqtt5(_ mqtt5: CocoaMQTT5, didReceiveAuthReasonCode reasonCode: CocoaMQTTAUTHReasonCode) {}
    func mqtt5DidPing(_ mqtt5: CocoaMQTT5) {}
    func mqtt5DidReceivePong(_ mqtt5: CocoaMQTT5) {}
}
```

- [ ] **Step 3: Delete MQTTMessage.swift**

```bash
rm TeamClawMobile/TeamClawMobile/Core/MQTT/MQTTMessage.swift
```

Remove from `project.pbxproj` as well.

- [ ] **Step 4: Update MockMQTTService**

```swift
import Combine
import Foundation

final class MockMQTTService: MQTTServiceProtocol {
    private let isConnectedSubject = CurrentValueSubject<Bool, Never>(false)
    private let receivedMessageSubject = PassthroughSubject<Teamclaw_MqttMessage, Never>()
    private let receivedDataSubject = PassthroughSubject<(topic: String, data: Data), Never>()

    var isConnected: AnyPublisher<Bool, Never> { isConnectedSubject.eraseToAnyPublisher() }
    var receivedMessage: AnyPublisher<Teamclaw_MqttMessage, Never> { receivedMessageSubject.eraseToAnyPublisher() }
    var receivedData: AnyPublisher<(topic: String, data: Data), Never> { receivedDataSubject.eraseToAnyPublisher() }

    private(set) var connectCalls: [(host: String, port: UInt16, username: String, password: String)] = []
    private(set) var disconnectCallCount = 0
    private(set) var subscribeCalls: [(topic: String, qos: Int)] = []
    private(set) var publishCalls: [(topic: String, message: Teamclaw_MqttMessage, qos: Int)] = []

    func connect(host: String, port: UInt16, username: String, password: String) {
        connectCalls.append((host, port, username, password))
        isConnectedSubject.send(true)
    }

    func disconnect() {
        disconnectCallCount += 1
        isConnectedSubject.send(false)
    }

    func subscribe(topic: String, qos: Int) {
        subscribeCalls.append((topic, qos))
    }

    func publish(topic: String, message: Teamclaw_MqttMessage, qos: Int) {
        publishCalls.append((topic, message, qos))
    }

    func simulateMessage(_ message: Teamclaw_MqttMessage) {
        receivedMessageSubject.send(message)
    }

    func simulateDisconnect() {
        isConnectedSubject.send(false)
    }
}
```

- [ ] **Step 5: Commit**

```bash
git add -A TeamClawMobile/TeamClawMobile/Core/MQTT/
git commit -m "feat(ios): migrate MQTTService to protobuf binary transport"
```

---

## Task 8: iOS — Migrate all ViewModels to protobuf with pagination

**Files:**
- Modify: `TeamClawMobile/TeamClawMobile/Features/TeamMembers/MemberViewModel.swift`
- Modify: `TeamClawMobile/TeamClawMobile/Features/Skills/SkillViewModel.swift`
- Modify: `TeamClawMobile/TeamClawMobile/Features/TeamMembers/TalentViewModel.swift`
- Modify: `TeamClawMobile/TeamClawMobile/Features/Automation/TaskViewModel.swift`
- Modify: `TeamClawMobile/TeamClawMobile/Features/SessionList/SessionListViewModel.swift`

All five ViewModels follow the same pattern. Example for MemberViewModel (others are analogous):

- [ ] **Step 1: Update MemberViewModel**

```swift
import Combine
import Foundation
import SwiftData

@MainActor
final class MemberViewModel: ObservableObject {

    @Published var members: [TeamMember] = []

    private let modelContext: ModelContext
    private let mqttService: MQTTServiceProtocol
    private var cancellables = Set<AnyCancellable>()
    private var pendingMembers: [TeamMember] = []

    init(modelContext: ModelContext, mqttService: MQTTServiceProtocol) {
        self.modelContext = modelContext
        self.mqttService = mqttService
        subscribeToMQTT()
    }

    func loadMembers() {
        loadMembersFromDB()
        requestMembers(page: 1)
    }

    func requestMembers(page: Int = 1) {
        guard let creds = PairingManager().credentials else { return }
        let topic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"

        var req = Teamclaw_MemberSyncRequest()
        var pagination = Teamclaw_PageRequest()
        pagination.page = Int32(page)
        pagination.pageSize = 50
        req.pagination = pagination

        let msg = ProtoMQTTCoder.makeEnvelope(.memberSyncRequest(req))
        mqttService.publish(topic: topic, message: msg, qos: 1)
    }

    func collaborativeSessions(for member: TeamMember) -> [Session] {
        let descriptor = FetchDescriptor<Session>()
        guard let allSessions = try? modelContext.fetch(descriptor) else { return [] }
        return allSessions.filter { $0.isCollaborative && $0.collaboratorIDs.contains(member.id) }
    }

    private func subscribeToMQTT() {
        mqttService.receivedMessage
            .compactMap { msg -> Teamclaw_MemberSyncResponse? in
                if case .memberSyncResponse(let resp) = msg.payload { return resp }
                return nil
            }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] response in
                self?.handleMemberSync(response)
            }
            .store(in: &cancellables)
    }

    private func handleMemberSync(_ response: Teamclaw_MemberSyncResponse) {
        let pageInfo = response.pagination
        let isFirstPage = pageInfo.page <= 1

        if isFirstPage {
            // Clear pending buffer on first page
            pendingMembers = []
            // Delete existing
            let descriptor = FetchDescriptor<TeamMember>()
            if let existing = try? modelContext.fetch(descriptor) {
                for member in existing { modelContext.delete(member) }
            }
        }

        for data in response.members {
            let member = TeamMember(
                id: data.id,
                name: data.name,
                avatarURL: data.avatarURL,
                department: data.hasDepartment ? data.department : "",
                isAIAlly: data.isAiAlly,
                note: data.note
            )
            modelContext.insert(member)
        }

        try? modelContext.save()

        let hasMore = pageInfo.total > pageInfo.page * pageInfo.pageSize
        if hasMore {
            requestMembers(page: Int(pageInfo.page) + 1)
        } else {
            loadMembersFromDB()
        }
    }

    private func loadMembersFromDB() {
        let descriptor = FetchDescriptor<TeamMember>(sortBy: [SortDescriptor(\.name)])
        members = (try? modelContext.fetch(descriptor)) ?? []
    }
}
```

- [ ] **Step 2: Update SkillViewModel (same pattern)**

Replace `requestSkills()` to send `Teamclaw_SkillSyncRequest` with pagination. Subscribe to `.skillSyncResponse`. Handle pages the same way.

- [ ] **Step 3: Update TalentViewModel (same pattern)**

Replace `requestTalents()` to send `Teamclaw_TalentSyncRequest` with pagination. Subscribe to `.talentSyncResponse`.

- [ ] **Step 4: Update TaskViewModel (same pattern)**

Replace `requestAutomations()` to send `Teamclaw_AutomationSyncRequest` with pagination. Subscribe to both `.automationSyncResponse` and `.taskUpdate`. Keep `publishTaskUpdate` but use protobuf `Teamclaw_TaskUpdate`.

- [ ] **Step 5: Update SessionListViewModel**

Replace `requestSessionsFromDesktop()` to send `Teamclaw_SessionSyncRequest` with pagination. Subscribe to `.sessionSyncResponse`. Remove old `sessionListRequest` envelope.

- [ ] **Step 6: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/Features/
git commit -m "feat(ios): migrate all ViewModels to protobuf with pagination"
```

---

## Task 9: iOS — Migrate ChatDetailViewModel and MessageAggregator

**Files:**
- Modify: `TeamClawMobile/TeamClawMobile/Features/Chat/ChatDetailViewModel.swift`
- Modify: `TeamClawMobile/TeamClawMobile/Core/MessageAggregator.swift`

- [ ] **Step 1: Update MessageAggregator to use protobuf ChatResponse**

Change `feed(messageID:chunk:)` to accept `Teamclaw_ChatResponse`:

```swift
func feed(messageID: String, chunk: Teamclaw_ChatResponse) {
    lock.lock()
    defer { lock.unlock() }

    if states[messageID] == nil {
        states[messageID] = MessageState()
    }

    switch chunk.event {
    case .delta(let text):
        states[messageID]!.chunks[Int(chunk.seq)] = text
        let assembled = assembleInOrder(chunks: states[messageID]!.chunks)
        states[messageID]!.subject.send(assembled)
    case .done:
        states[messageID]!.isDone = true
        // No full field — client already has all deltas assembled
        let assembled = assembleInOrder(chunks: states[messageID]!.chunks)
        states[messageID]!.subject.send(assembled)
    case .error(let err):
        states[messageID]!.subject.send("[Error: \(err.message)]")
    case .none:
        break
    }
}
```

- [ ] **Step 2: Update ChatDetailViewModel**

Replace `sendMessage()` to construct protobuf:

```swift
func sendMessage() {
    let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, isDesktopOnline else { return }

    let message = ChatMessage(id: UUID().uuidString, sessionID: sessionID, role: .user, content: text, timestamp: Date())
    modelContext.insert(message)
    try? modelContext.save()
    messages.append(message)
    inputText = ""

    var req = Teamclaw_ChatRequest()
    req.session_id = sessionID
    req.content = text
    if selectedModel != "default" { req.model = selectedModel }

    guard let creds = PairingManager().credentials else { return }
    let topic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"
    let msg = ProtoMQTTCoder.makeEnvelope(.chatRequest(req))
    mqttService.publish(topic: topic, message: msg, qos: 1)
}
```

Update `subscribeToMQTT()` to match protobuf `ChatResponse`:

```swift
private func subscribeToMQTT() {
    mqttService.receivedMessage
        .receive(on: DispatchQueue.main)
        .sink { [weak self] mqttMessage in
            guard let self else { return }
            if case .chatResponse(let response) = mqttMessage.payload,
               response.sessionID == self.sessionID {
                self.handleStreamChunk(response: response)
            }
        }
        .store(in: &cancellables)
}
```

Update `handleStreamChunk` to handle the new event types:

```swift
func handleStreamChunk(response: Teamclaw_ChatResponse) {
    if !isStreaming {
        isStreaming = true
        streamingContent = ""
        let messageID = UUID().uuidString
        currentStreamingMessageID = messageID
        aggregatorCancellable = aggregator.assembledContent(for: messageID)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] content in self?.streamingContent = content }
    }

    guard let messageID = currentStreamingMessageID else { return }
    aggregator.feed(messageID: messageID, chunk: response)

    switch response.event {
    case .done:
        let finalContent = streamingContent
        finishStreaming(messageID: messageID, content: finalContent)
    case .error(let err):
        let errorContent = streamingContent + "\n[Error: \(err.message)]"
        finishStreaming(messageID: messageID, content: errorContent)
    default:
        break
    }
}

private func finishStreaming(messageID: String, content: String) {
    isStreaming = false
    let assistantMessage = ChatMessage(
        id: UUID().uuidString, sessionID: sessionID, role: .assistant,
        content: content, timestamp: Date()
    )
    modelContext.insert(assistantMessage)
    try? modelContext.save()
    messages.append(assistantMessage)
    streamingContent = ""
    aggregator.reset(messageID: messageID)
    currentStreamingMessageID = nil
    aggregatorCancellable = nil
}
```

Add cancel support:

```swift
func cancelStreaming() {
    guard isStreaming else { return }
    var cancel = Teamclaw_ChatCancel()
    cancel.sessionID = sessionID
    guard let creds = PairingManager().credentials else { return }
    let topic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"
    let msg = ProtoMQTTCoder.makeEnvelope(.chatCancel(cancel))
    mqttService.publish(topic: topic, message: msg, qos: 1)
}
```

- [ ] **Step 3: Update sendImageMessage similarly**

Same pattern as `sendMessage()` but set `req.imageURL = ossURL`.

- [ ] **Step 4: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/Features/Chat/ TeamClawMobile/TeamClawMobile/Core/MessageAggregator.swift
git commit -m "feat(ios): migrate chat to protobuf with StreamDone/StreamError/ChatCancel"
```

---

## Task 10: iOS — Migrate PairingManager to protobuf

**Files:**
- Modify: `TeamClawMobile/TeamClawMobile/Core/PairingManager.swift`

- [ ] **Step 1: Update handleMessage to decode protobuf**

In `PairingService`, replace JSON parsing:

```swift
func handleMessage(_ mqtt: CocoaMQTT5, message: CocoaMQTT5Message) {
    let data = Data(message.payload)
    guard let msg = ProtoMQTTCoder.decode(data) else { return }

    switch msg.payload {
    case .pairingDiscovery(let discovery):
        discoveredTeamID = discovery.teamID
        discoveredDesktopDeviceID = discovery.deviceID
        // Subscribe to pairing topic and send request
        sendPairingRequest(mqtt)

    case .pairingResponse(let response):
        let result = PairingResult(
            host: response.mqttHost,
            port: UInt16(response.mqttPort),
            username: response.mqttUsername,
            password: response.mqttPassword,
            teamID: response.teamID,
            desktopDeviceID: response.desktopDeviceID,
            desktopName: response.desktopDeviceName
        )
        succeed(result)

    default:
        break
    }
}
```

- [ ] **Step 2: Update sendPairingRequest to use protobuf**

```swift
private func sendPairingRequest(_ mqtt: CocoaMQTT5) {
    guard let teamID = discoveredTeamID else { return }

    var req = Teamclaw_PairingRequest()
    req.deviceID = mobileDeviceID
    req.deviceName = mobileDeviceName

    let msg = ProtoMQTTCoder.makeEnvelope(.pairingRequest(req))
    guard let data = ProtoMQTTCoder.encode(msg) else { return }

    let topic = "teamclaw/pairing/\(code)"
    let props = MqttPublishProperties()
    mqtt.publish(CocoaMQTT5Message(topic: topic, payload: [UInt8](data)), qos: .qos1, DUP: false, retained: false, properties: props)
}
```

- [ ] **Step 3: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/Core/PairingManager.swift
git commit -m "feat(ios): migrate pairing handshake to protobuf"
```

---

## Task 11: iOS — Update tests

**Files:**
- Modify: `TeamClawMobile/TeamClawMobileTests/Core/MQTTMessageTests.swift`
- Modify: `TeamClawMobile/TeamClawMobileTests/Core/MessageAggregatorTests.swift`

- [ ] **Step 1: Rewrite MQTTMessageTests for protobuf round-trips**

```swift
import XCTest
import SwiftProtobuf
@testable import TeamClawMobile

final class MQTTMessageTests: XCTestCase {

    func testChatRequestRoundTrip() throws {
        var req = Teamclaw_ChatRequest()
        req.sessionID = "s1"
        req.content = "Hello"
        req.model = "claude-3-5-sonnet"

        let msg = ProtoMQTTCoder.makeEnvelope(.chatRequest(req))
        let data = try XCTUnwrap(ProtoMQTTCoder.encode(msg))
        let decoded = try XCTUnwrap(ProtoMQTTCoder.decode(data))

        guard case .chatRequest(let payload) = decoded.payload else {
            XCTFail("Expected chatRequest")
            return
        }
        XCTAssertEqual(payload.sessionID, "s1")
        XCTAssertEqual(payload.content, "Hello")
        XCTAssertEqual(payload.model, "claude-3-5-sonnet")
    }

    func testChatResponseDelta() throws {
        var resp = Teamclaw_ChatResponse()
        resp.sessionID = "s1"
        resp.seq = 0
        resp.event = .delta("你好")

        let msg = ProtoMQTTCoder.makeEnvelope(.chatResponse(resp))
        let data = try XCTUnwrap(ProtoMQTTCoder.encode(msg))
        let decoded = try XCTUnwrap(ProtoMQTTCoder.decode(data))

        guard case .chatResponse(let payload) = decoded.payload else {
            XCTFail("Expected chatResponse")
            return
        }
        XCTAssertEqual(payload.sessionID, "s1")
        XCTAssertEqual(payload.seq, 0)
        guard case .delta(let text) = payload.event else {
            XCTFail("Expected delta event")
            return
        }
        XCTAssertEqual(text, "你好")
    }

    func testChatResponseDone() throws {
        var resp = Teamclaw_ChatResponse()
        resp.sessionID = "s1"
        resp.seq = 5
        resp.event = .done(Teamclaw_StreamDone())

        let msg = ProtoMQTTCoder.makeEnvelope(.chatResponse(resp))
        let data = try XCTUnwrap(ProtoMQTTCoder.encode(msg))
        let decoded = try XCTUnwrap(ProtoMQTTCoder.decode(data))

        guard case .chatResponse(let payload) = decoded.payload else {
            XCTFail("Expected chatResponse")
            return
        }
        guard case .done = payload.event else {
            XCTFail("Expected done event")
            return
        }
    }

    func testChatResponseError() throws {
        var err = Teamclaw_StreamError()
        err.message = "rate limited"
        var resp = Teamclaw_ChatResponse()
        resp.sessionID = "s1"
        resp.seq = 3
        resp.event = .error(err)

        let msg = ProtoMQTTCoder.makeEnvelope(.chatResponse(resp))
        let data = try XCTUnwrap(ProtoMQTTCoder.encode(msg))
        let decoded = try XCTUnwrap(ProtoMQTTCoder.decode(data))

        guard case .chatResponse(let payload) = decoded.payload,
              case .error(let streamErr) = payload.event else {
            XCTFail("Expected error event")
            return
        }
        XCTAssertEqual(streamErr.message, "rate limited")
    }

    func testMemberSyncWithPagination() throws {
        var member = Teamclaw_MemberData()
        member.id = "m1"
        member.name = "Alice"
        member.avatarURL = "https://example.com/a.png"
        member.isAiAlly = false
        member.note = ""

        var pageInfo = Teamclaw_PageInfo()
        pageInfo.page = 1
        pageInfo.pageSize = 50
        pageInfo.total = 1

        var resp = Teamclaw_MemberSyncResponse()
        resp.members = [member]
        resp.pagination = pageInfo

        let msg = ProtoMQTTCoder.makeEnvelope(.memberSyncResponse(resp))
        let data = try XCTUnwrap(ProtoMQTTCoder.encode(msg))
        let decoded = try XCTUnwrap(ProtoMQTTCoder.decode(data))

        guard case .memberSyncResponse(let payload) = decoded.payload else {
            XCTFail("Expected memberSyncResponse")
            return
        }
        XCTAssertEqual(payload.members.count, 1)
        XCTAssertEqual(payload.members[0].name, "Alice")
        XCTAssertEqual(payload.pagination.total, 1)
    }

    func testStatusReport() throws {
        var status = Teamclaw_StatusReport()
        status.online = true
        status.deviceName = "MacBook Pro"

        let msg = ProtoMQTTCoder.makeEnvelope(.statusReport(status))
        let data = try XCTUnwrap(ProtoMQTTCoder.encode(msg))
        let decoded = try XCTUnwrap(ProtoMQTTCoder.decode(data))

        guard case .statusReport(let payload) = decoded.payload else {
            XCTFail("Expected statusReport")
            return
        }
        XCTAssertTrue(payload.online)
        XCTAssertEqual(payload.deviceName, "MacBook Pro")
    }
}
```

- [ ] **Step 2: Update MessageAggregatorTests**

Update to construct `Teamclaw_ChatResponse` instead of `ChatResponsePayload`.

- [ ] **Step 3: Run tests**

```bash
cd TeamClawMobile && xcodebuild test -scheme TeamClawMobile -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 16' 2>&1 | tail -30
```

- [ ] **Step 4: Commit**

```bash
git add TeamClawMobile/TeamClawMobileTests/
git commit -m "test(ios): rewrite MQTT tests for protobuf encode/decode"
```

---

## Task 12: ConnectionMonitor — update status subscription

**Files:**
- Modify: `TeamClawMobile/TeamClawMobile/Core/ConnectionMonitor.swift`

- [ ] **Step 1: Update status message handling**

The ConnectionMonitor subscribes to status messages. Update it to match `Teamclaw_StatusReport` from the protobuf envelope instead of the old JSON `StatusPayload`.

```swift
mqttService.receivedMessage
    .compactMap { msg -> Teamclaw_StatusReport? in
        if case .statusReport(let status) = msg.payload { return status }
        return nil
    }
    .receive(on: DispatchQueue.main)
    .sink { [weak self] status in
        self?.isDesktopOnline = status.online
        if status.hasDeviceName {
            self?.desktopDeviceName = status.deviceName
        }
    }
    .store(in: &cancellables)
```

- [ ] **Step 2: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/Core/ConnectionMonitor.swift
git commit -m "feat(ios): migrate ConnectionMonitor to protobuf StatusReport"
```

---

## Task 13: Final build verification

- [ ] **Step 1: Build iOS**

```bash
cd TeamClawMobile && xcodebuild -scheme TeamClawMobile -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 16' build 2>&1 | tail -20
```

Expected: BUILD SUCCEEDED

- [ ] **Step 2: Run iOS tests**

```bash
cd TeamClawMobile && xcodebuild test -scheme TeamClawMobile -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 16' 2>&1 | tail -30
```

Expected: All tests pass.

- [ ] **Step 3: Build Rust**

```bash
cd src-tauri && cargo build 2>&1 | tail -20
```

Expected: Build succeeds.

- [ ] **Step 4: Commit any remaining fixes**

```bash
git add -A && git commit -m "fix: address build issues from protobuf migration"
```

- [ ] **Step 5: Final commit — update spec as implemented**

```bash
git add docs/
git commit -m "docs: finalize protobuf migration spec and plan"
```

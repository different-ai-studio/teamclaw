# TeamClaw iOS Mobile Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native iOS app (SwiftUI) that serves as a remote frontend for the TeamClaw desktop app, communicating via MQTT through an EMQX broker.

**Architecture:** MVVM + Combine with CocoaMQTT for broker communication. SwiftData for local persistence. The app connects to the desktop via MQTT topics, displays Agent conversations with streaming Markdown, and provides access to automation tasks and skills. All Agent execution happens on the desktop — the iOS app is a thin presentation layer.

**Tech Stack:** Swift 6, SwiftUI (iOS 16+), CocoaMQTT, SwiftData, swift-markdown, Alamofire (OSS upload)

**Note:** The MQTT broker and desktop relay module do not exist yet. This plan uses a `MockMQTTService` protocol-based abstraction so the iOS app can be developed and tested independently with mock data. When the broker/desktop are ready, swap in the real implementation.

---

## File Structure

```
TeamClawMobile/
├── TeamClawMobile.xcodeproj
├── TeamClawMobile/
│   ├── App/
│   │   ├── TeamClawMobileApp.swift          # App entry point, dependency injection
│   │   └── ContentView.swift                # Root view with navigation
│   ├── Core/
│   │   ├── MQTT/
│   │   │   ├── MQTTServiceProtocol.swift    # Protocol for MQTT operations
│   │   │   ├── MQTTService.swift            # Real CocoaMQTT implementation
│   │   │   ├── MockMQTTService.swift        # Mock for development/testing
│   │   │   └── MQTTMessage.swift            # Message types and JSON codables
│   │   ├── MessageAggregator.swift          # Stream chunk assembly (seq ordering)
│   │   ├── ConnectionMonitor.swift          # Desktop online/offline state
│   │   ├── OSSUploader.swift                # Alibaba Cloud OSS image upload
│   │   └── PairingManager.swift             # 6-digit pairing code flow
│   ├── Models/
│   │   ├── Session.swift                    # SwiftData @Model for sessions
│   │   ├── ChatMessage.swift                # SwiftData @Model for messages
│   │   ├── TeamMember.swift                 # SwiftData @Model for members
│   │   ├── AutomationTask.swift             # SwiftData @Model for cron tasks
│   │   └── Skill.swift                      # SwiftData @Model for skills
│   ├── Features/
│   │   ├── SessionList/
│   │   │   ├── SessionListView.swift        # Home page: iMessage-style list
│   │   │   └── SessionListViewModel.swift
│   │   ├── Chat/
│   │   │   ├── ChatDetailView.swift         # Conversation view
│   │   │   ├── ChatDetailViewModel.swift
│   │   │   ├── MessageBubbleView.swift      # User/AI/Member bubble styles
│   │   │   ├── StreamingTextView.swift      # Animated streaming text
│   │   │   └── ChatInputBar.swift           # Input + model picker + attachment
│   │   ├── TeamMembers/
│   │   │   ├── MemberListView.swift         # Team member list
│   │   │   ├── MemberSessionsView.swift     # Sessions shared with a member
│   │   │   └── MemberViewModel.swift
│   │   ├── Automation/
│   │   │   ├── TaskListView.swift           # Automation task CRUD
│   │   │   ├── TaskEditView.swift           # Add/edit task form
│   │   │   └── TaskViewModel.swift
│   │   ├── Skills/
│   │   │   ├── SkillHomeView.swift          # Personal + team skills
│   │   │   └── SkillViewModel.swift
│   │   ├── FunctionPanel/
│   │   │   └── FunctionPanelView.swift      # Left nav: automation, skills, settings
│   │   └── Settings/
│   │       ├── SettingsView.swift           # Main settings
│   │       ├── PairingView.swift            # Device pairing UI
│   │       └── NotificationPrefView.swift   # Notification preferences
│   ├── Shared/
│   │   ├── MarkdownRenderer.swift           # Markdown → AttributedString
│   │   ├── DesktopStatusBadge.swift         # Online/offline indicator
│   │   └── LiquidGlassBar.swift             # Bottom floating bar component
│   └── Resources/
│       ├── Assets.xcassets
│       └── Localizable.xcstrings            # i18n (en, zh-CN)
├── TeamClawMobileTests/
│   ├── Core/
│   │   ├── MQTTMessageTests.swift
│   │   ├── MessageAggregatorTests.swift
│   │   └── ConnectionMonitorTests.swift
│   ├── Models/
│   │   └── ModelTests.swift
│   └── Features/
│       ├── SessionListViewModelTests.swift
│       ├── ChatDetailViewModelTests.swift
│       └── TaskViewModelTests.swift
└── TeamClawMobileUITests/
    └── NavigationUITests.swift
```

---

### Task 1: Xcode Project Setup & Dependencies

**Files:**
- Create: `TeamClawMobile/TeamClawMobile.xcodeproj`
- Create: `TeamClawMobile/TeamClawMobile/App/TeamClawMobileApp.swift`
- Create: `TeamClawMobile/Package.swift` (if using SPM)

- [ ] **Step 1: Create Xcode project**

Open Xcode → File → New → Project → iOS App:
- Product Name: `TeamClawMobile`
- Organization Identifier: `com.teamclaw`
- Interface: SwiftUI
- Language: Swift
- Storage: SwiftData
- Deployment Target: iOS 16.0

Create this in the worktree root: `/Volumes/openbeta/workspace/teamclaw/.worktrees/mobile-client/TeamClawMobile/`

- [ ] **Step 2: Add SPM dependencies**

In Xcode: File → Add Package Dependencies:

| Package | URL | Version |
|---------|-----|---------|
| CocoaMQTT | `https://github.com/emqx/CocoaMQTT.git` | 2.1.x |
| swift-markdown | `https://github.com/apple/swift-markdown.git` | 0.4.x |
| Alamofire | `https://github.com/Alamofire/Alamofire.git` | 5.9.x |

- [ ] **Step 3: Create folder structure**

Create the directory structure per the File Structure above. Create empty placeholder files:

```swift
// TeamClawMobile/App/TeamClawMobileApp.swift
import SwiftUI
import SwiftData

@main
struct TeamClawMobileApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .modelContainer(for: [
            Session.self,
            ChatMessage.self,
            TeamMember.self,
            AutomationTask.self,
            Skill.self
        ])
    }
}
```

```swift
// TeamClawMobile/App/ContentView.swift
import SwiftUI

struct ContentView: View {
    var body: some View {
        Text("TeamClaw Mobile")
    }
}
```

- [ ] **Step 4: Verify project builds**

Run: Cmd+B in Xcode (or `xcodebuild -scheme TeamClawMobile -destination 'platform=iOS Simulator,name=iPhone 16'`)
Expected: BUILD SUCCEEDED

- [ ] **Step 5: Commit**

```bash
git add TeamClawMobile/
git commit -m "feat(mobile): scaffold iOS project with SPM dependencies"
```

---

### Task 2: Data Models (SwiftData)

**Files:**
- Create: `TeamClawMobile/TeamClawMobile/Models/Session.swift`
- Create: `TeamClawMobile/TeamClawMobile/Models/ChatMessage.swift`
- Create: `TeamClawMobile/TeamClawMobile/Models/TeamMember.swift`
- Create: `TeamClawMobile/TeamClawMobile/Models/AutomationTask.swift`
- Create: `TeamClawMobile/TeamClawMobile/Models/Skill.swift`
- Create: `TeamClawMobileTests/Models/ModelTests.swift`

- [ ] **Step 1: Write model tests**

```swift
// TeamClawMobileTests/Models/ModelTests.swift
import XCTest
import SwiftData
@testable import TeamClawMobile

final class ModelTests: XCTestCase {
    var container: ModelContainer!

    override func setUp() {
        let config = ModelConfiguration(isStoredInMemoryOnly: true)
        container = try! ModelContainer(
            for: Session.self, ChatMessage.self, TeamMember.self, AutomationTask.self, Skill.self,
            configurations: config
        )
    }

    func testSessionCreation() {
        let session = Session(
            id: "s1",
            title: "运营搭档",
            agentName: "运营搭档",
            agentAvatarURL: nil,
            lastMessageContent: "帮你整理了日报",
            lastMessageTime: Date(),
            isCollaborative: false,
            collaboratorIDs: []
        )
        XCTAssertEqual(session.title, "运营搭档")
        XCTAssertFalse(session.isCollaborative)
    }

    func testCollaborativeSession() {
        let session = Session(
            id: "s2",
            title: "Q2 目标讨论",
            agentName: "代码搭档",
            agentAvatarURL: nil,
            lastMessageContent: "张三: 方案可以",
            lastMessageTime: Date(),
            isCollaborative: true,
            collaboratorIDs: ["member1", "member2"]
        )
        XCTAssertTrue(session.isCollaborative)
        XCTAssertEqual(session.collaboratorIDs.count, 2)
    }

    func testChatMessageTypes() {
        let aiMsg = ChatMessage(
            id: "m1",
            sessionID: "s1",
            role: .assistant,
            content: "分析结果如下",
            timestamp: Date(),
            senderName: nil,
            isStreaming: false
        )
        XCTAssertEqual(aiMsg.role, .assistant)

        let userMsg = ChatMessage(
            id: "m2",
            sessionID: "s1",
            role: .user,
            content: "帮我做周报",
            timestamp: Date(),
            senderName: nil,
            isStreaming: false
        )
        XCTAssertEqual(userMsg.role, .user)

        let memberMsg = ChatMessage(
            id: "m3",
            sessionID: "s2",
            role: .collaborator,
            content: "这个方案可以",
            timestamp: Date(),
            senderName: "张三",
            isStreaming: false
        )
        XCTAssertEqual(memberMsg.role, .collaborator)
        XCTAssertEqual(memberMsg.senderName, "张三")
    }

    func testAutomationTask() {
        let task = AutomationTask(
            id: "t1",
            name: "每日运营日报",
            status: .running,
            lastRunTime: Date(),
            cronExpression: "0 9 * * *",
            description: "每天早上9点生成运营日报"
        )
        XCTAssertEqual(task.status, .running)
    }

    func testSkill() {
        let skill = Skill(
            id: "sk1",
            name: "数据分析",
            description: "分析运营数据并生成报表",
            isPersonal: true,
            isEnabled: true
        )
        XCTAssertTrue(skill.isPersonal)
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `xcodebuild test -scheme TeamClawMobile -destination 'platform=iOS Simulator,name=iPhone 16'`
Expected: Compilation errors — models not defined yet

- [ ] **Step 3: Implement Session model**

```swift
// TeamClawMobile/Models/Session.swift
import Foundation
import SwiftData

@Model
final class Session {
    @Attribute(.unique) var id: String
    var title: String
    var agentName: String
    var agentAvatarURL: String?
    var lastMessageContent: String
    var lastMessageTime: Date
    var isCollaborative: Bool
    var collaboratorIDs: [String]

    init(
        id: String,
        title: String,
        agentName: String,
        agentAvatarURL: String?,
        lastMessageContent: String,
        lastMessageTime: Date,
        isCollaborative: Bool,
        collaboratorIDs: [String]
    ) {
        self.id = id
        self.title = title
        self.agentName = agentName
        self.agentAvatarURL = agentAvatarURL
        self.lastMessageContent = lastMessageContent
        self.lastMessageTime = lastMessageTime
        self.isCollaborative = isCollaborative
        self.collaboratorIDs = collaboratorIDs
    }
}
```

- [ ] **Step 4: Implement ChatMessage model**

```swift
// TeamClawMobile/Models/ChatMessage.swift
import Foundation
import SwiftData

enum MessageRole: String, Codable {
    case user
    case assistant
    case collaborator
}

@Model
final class ChatMessage {
    @Attribute(.unique) var id: String
    var sessionID: String
    var roleRaw: String
    var content: String
    var timestamp: Date
    var senderName: String?
    var isStreaming: Bool
    var imageURL: String?

    var role: MessageRole {
        get { MessageRole(rawValue: roleRaw) ?? .user }
        set { roleRaw = newValue.rawValue }
    }

    init(
        id: String,
        sessionID: String,
        role: MessageRole,
        content: String,
        timestamp: Date,
        senderName: String?,
        isStreaming: Bool,
        imageURL: String? = nil
    ) {
        self.id = id
        self.sessionID = sessionID
        self.roleRaw = role.rawValue
        self.content = content
        self.timestamp = timestamp
        self.senderName = senderName
        self.isStreaming = isStreaming
        self.imageURL = imageURL
    }
}
```

- [ ] **Step 5: Implement remaining models**

```swift
// TeamClawMobile/Models/TeamMember.swift
import Foundation
import SwiftData

@Model
final class TeamMember {
    @Attribute(.unique) var id: String
    var name: String
    var avatarURL: String?
    var note: String?

    init(id: String, name: String, avatarURL: String?, note: String?) {
        self.id = id
        self.name = name
        self.avatarURL = avatarURL
        self.note = note
    }
}
```

```swift
// TeamClawMobile/Models/AutomationTask.swift
import Foundation
import SwiftData

enum TaskStatus: String, Codable {
    case running
    case completed
    case failed
    case idle
}

@Model
final class AutomationTask {
    @Attribute(.unique) var id: String
    var name: String
    var statusRaw: String
    var lastRunTime: Date?
    var cronExpression: String
    var taskDescription: String

    var status: TaskStatus {
        get { TaskStatus(rawValue: statusRaw) ?? .idle }
        set { statusRaw = newValue.rawValue }
    }

    init(
        id: String,
        name: String,
        status: TaskStatus,
        lastRunTime: Date?,
        cronExpression: String,
        description: String
    ) {
        self.id = id
        self.name = name
        self.statusRaw = status.rawValue
        self.lastRunTime = lastRunTime
        self.cronExpression = cronExpression
        self.taskDescription = description
    }
}
```

```swift
// TeamClawMobile/Models/Skill.swift
import Foundation
import SwiftData

@Model
final class Skill {
    @Attribute(.unique) var id: String
    var name: String
    var skillDescription: String
    var isPersonal: Bool
    var isEnabled: Bool

    init(id: String, name: String, description: String, isPersonal: Bool, isEnabled: Bool) {
        self.id = id
        self.name = name
        self.skillDescription = description
        self.isPersonal = isPersonal
        self.isEnabled = isEnabled
    }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `xcodebuild test -scheme TeamClawMobile -destination 'platform=iOS Simulator,name=iPhone 16'`
Expected: All 5 tests PASS

- [ ] **Step 7: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/Models/ TeamClawMobileTests/Models/
git commit -m "feat(mobile): add SwiftData models for sessions, messages, members, tasks, skills"
```

---

### Task 3: MQTT Service Protocol & Mock

**Files:**
- Create: `TeamClawMobile/TeamClawMobile/Core/MQTT/MQTTServiceProtocol.swift`
- Create: `TeamClawMobile/TeamClawMobile/Core/MQTT/MQTTMessage.swift`
- Create: `TeamClawMobile/TeamClawMobile/Core/MQTT/MockMQTTService.swift`
- Create: `TeamClawMobileTests/Core/MQTTMessageTests.swift`

- [ ] **Step 1: Write message parsing tests**

```swift
// TeamClawMobileTests/Core/MQTTMessageTests.swift
import XCTest
@testable import TeamClawMobile

final class MQTTMessageTests: XCTestCase {

    func testDecodeChatResponse() throws {
        let json = """
        {"id":"msg1","type":"chat_response","timestamp":1712000000,"payload":{"session_id":"s1","seq":0,"delta":"你好","done":false}}
        """
        let msg = try JSONDecoder().decode(MQTTMessage.self, from: json.data(using: .utf8)!)
        XCTAssertEqual(msg.id, "msg1")
        XCTAssertEqual(msg.type, .chatResponse)
        if case .chatResponse(let payload) = msg.payload {
            XCTAssertEqual(payload.sessionID, "s1")
            XCTAssertEqual(payload.seq, 0)
            XCTAssertEqual(payload.delta, "你好")
            XCTAssertFalse(payload.done)
            XCTAssertNil(payload.full)
        } else {
            XCTFail("Expected chatResponse payload")
        }
    }

    func testDecodeFinalChatResponse() throws {
        let json = """
        {"id":"msg2","type":"chat_response","timestamp":1712000001,"payload":{"session_id":"s1","seq":2,"delta":"完","done":true,"full":"你好，完"}}
        """
        let msg = try JSONDecoder().decode(MQTTMessage.self, from: json.data(using: .utf8)!)
        if case .chatResponse(let payload) = msg.payload {
            XCTAssertTrue(payload.done)
            XCTAssertEqual(payload.full, "你好，完")
        } else {
            XCTFail("Expected chatResponse payload")
        }
    }

    func testDecodeStatusMessage() throws {
        let json = """
        {"id":"s1","type":"status","timestamp":1712000000,"payload":{"online":true,"device_name":"MacBook Pro"}}
        """
        let msg = try JSONDecoder().decode(MQTTMessage.self, from: json.data(using: .utf8)!)
        XCTAssertEqual(msg.type, .status)
        if case .status(let payload) = msg.payload {
            XCTAssertTrue(payload.online)
            XCTAssertEqual(payload.deviceName, "MacBook Pro")
        } else {
            XCTFail("Expected status payload")
        }
    }

    func testEncodeChatRequest() throws {
        let payload = ChatRequestPayload(sessionID: "s1", content: "帮我做周报", imageURL: nil, model: "gpt-4")
        let msg = MQTTMessage(
            id: "req1",
            type: .chatRequest,
            timestamp: 1712000000,
            payload: .chatRequest(payload)
        )
        let data = try JSONEncoder().encode(msg)
        let decoded = try JSONDecoder().decode(MQTTMessage.self, from: data)
        XCTAssertEqual(decoded.id, "req1")
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `xcodebuild test -scheme TeamClawMobile -destination 'platform=iOS Simulator,name=iPhone 16'`
Expected: Compilation errors — types not defined

- [ ] **Step 3: Implement MQTTMessage types**

```swift
// TeamClawMobile/Core/MQTT/MQTTMessage.swift
import Foundation

enum MQTTMessageType: String, Codable {
    case chatRequest = "chat_request"
    case chatResponse = "chat_response"
    case status
    case taskUpdate = "task_update"
    case skillSync = "skill_sync"
    case memberSync = "member_sync"
}

struct ChatRequestPayload: Codable {
    let sessionID: String
    let content: String
    let imageURL: String?
    let model: String?

    enum CodingKeys: String, CodingKey {
        case sessionID = "session_id"
        case content
        case imageURL = "image_url"
        case model
    }
}

struct ChatResponsePayload: Codable {
    let sessionID: String
    let seq: Int
    let delta: String
    let done: Bool
    let full: String?

    enum CodingKeys: String, CodingKey {
        case sessionID = "session_id"
        case seq, delta, done, full
    }
}

struct StatusPayload: Codable {
    let online: Bool
    let deviceName: String?

    enum CodingKeys: String, CodingKey {
        case online
        case deviceName = "device_name"
    }
}

struct TaskUpdatePayload: Codable {
    let taskID: String
    let status: String
    let lastRunTime: TimeInterval?

    enum CodingKeys: String, CodingKey {
        case taskID = "task_id"
        case status
        case lastRunTime = "last_run_time"
    }
}

struct SkillSyncPayload: Codable {
    let skills: [SkillData]

    struct SkillData: Codable {
        let id: String
        let name: String
        let description: String
        let isPersonal: Bool
        let isEnabled: Bool

        enum CodingKeys: String, CodingKey {
            case id, name, description
            case isPersonal = "is_personal"
            case isEnabled = "is_enabled"
        }
    }
}

struct MemberSyncPayload: Codable {
    let members: [MemberData]

    struct MemberData: Codable {
        let id: String
        let name: String
        let avatarURL: String?
        let note: String?

        enum CodingKeys: String, CodingKey {
            case id, name
            case avatarURL = "avatar_url"
            case note
        }
    }
}

enum MQTTPayload: Codable {
    case chatRequest(ChatRequestPayload)
    case chatResponse(ChatResponsePayload)
    case status(StatusPayload)
    case taskUpdate(TaskUpdatePayload)
    case skillSync(SkillSyncPayload)
    case memberSync(MemberSyncPayload)

    enum CodingKeys: String, CodingKey {
        case type
    }

    // Custom encoding handled by MQTTMessage
}

struct MQTTMessage: Codable {
    let id: String
    let type: MQTTMessageType
    let timestamp: TimeInterval
    let payload: MQTTPayload

    enum CodingKeys: String, CodingKey {
        case id, type, timestamp, payload
    }

    init(id: String, type: MQTTMessageType, timestamp: TimeInterval, payload: MQTTPayload) {
        self.id = id
        self.type = type
        self.timestamp = timestamp
        self.payload = payload
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        type = try container.decode(MQTTMessageType.self, forKey: .type)
        timestamp = try container.decode(TimeInterval.self, forKey: .timestamp)

        switch type {
        case .chatRequest:
            payload = .chatRequest(try container.decode(ChatRequestPayload.self, forKey: .payload))
        case .chatResponse:
            payload = .chatResponse(try container.decode(ChatResponsePayload.self, forKey: .payload))
        case .status:
            payload = .status(try container.decode(StatusPayload.self, forKey: .payload))
        case .taskUpdate:
            payload = .taskUpdate(try container.decode(TaskUpdatePayload.self, forKey: .payload))
        case .skillSync:
            payload = .skillSync(try container.decode(SkillSyncPayload.self, forKey: .payload))
        case .memberSync:
            payload = .memberSync(try container.decode(MemberSyncPayload.self, forKey: .payload))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(type, forKey: .type)
        try container.encode(timestamp, forKey: .timestamp)

        switch payload {
        case .chatRequest(let p): try container.encode(p, forKey: .payload)
        case .chatResponse(let p): try container.encode(p, forKey: .payload)
        case .status(let p): try container.encode(p, forKey: .payload)
        case .taskUpdate(let p): try container.encode(p, forKey: .payload)
        case .skillSync(let p): try container.encode(p, forKey: .payload)
        case .memberSync(let p): try container.encode(p, forKey: .payload)
        }
    }
}
```

- [ ] **Step 4: Implement MQTTServiceProtocol and MockMQTTService**

```swift
// TeamClawMobile/Core/MQTT/MQTTServiceProtocol.swift
import Foundation
import Combine

protocol MQTTServiceProtocol: AnyObject {
    var isConnected: AnyPublisher<Bool, Never> { get }
    var receivedMessage: AnyPublisher<MQTTMessage, Never> { get }

    func connect(host: String, port: UInt16, username: String, password: String)
    func disconnect()
    func subscribe(topic: String, qos: Int)
    func publish(topic: String, message: MQTTMessage, qos: Int)
}
```

```swift
// TeamClawMobile/Core/MQTT/MockMQTTService.swift
import Foundation
import Combine

final class MockMQTTService: MQTTServiceProtocol {
    private let connectedSubject = CurrentValueSubject<Bool, Never>(false)
    private let messageSubject = PassthroughSubject<MQTTMessage, Never>()

    var isConnected: AnyPublisher<Bool, Never> { connectedSubject.eraseToAnyPublisher() }
    var receivedMessage: AnyPublisher<MQTTMessage, Never> { messageSubject.eraseToAnyPublisher() }

    func connect(host: String, port: UInt16, username: String, password: String) {
        connectedSubject.send(true)
    }

    func disconnect() {
        connectedSubject.send(false)
    }

    func subscribe(topic: String, qos: Int) {}

    func publish(topic: String, message: MQTTMessage, qos: Int) {}

    // Test helpers
    func simulateMessage(_ message: MQTTMessage) {
        messageSubject.send(message)
    }

    func simulateDisconnect() {
        connectedSubject.send(false)
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `xcodebuild test -scheme TeamClawMobile -destination 'platform=iOS Simulator,name=iPhone 16'`
Expected: All MQTTMessageTests PASS

- [ ] **Step 6: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/Core/MQTT/ TeamClawMobileTests/Core/
git commit -m "feat(mobile): add MQTT message types, service protocol, and mock implementation"
```

---

### Task 4: Message Aggregator & Connection Monitor

**Files:**
- Create: `TeamClawMobile/TeamClawMobile/Core/MessageAggregator.swift`
- Create: `TeamClawMobile/TeamClawMobile/Core/ConnectionMonitor.swift`
- Create: `TeamClawMobileTests/Core/MessageAggregatorTests.swift`
- Create: `TeamClawMobileTests/Core/ConnectionMonitorTests.swift`

- [ ] **Step 1: Write MessageAggregator tests**

```swift
// TeamClawMobileTests/Core/MessageAggregatorTests.swift
import XCTest
import Combine
@testable import TeamClawMobile

final class MessageAggregatorTests: XCTestCase {
    var aggregator: MessageAggregator!
    var cancellables: Set<AnyCancellable>!

    override func setUp() {
        aggregator = MessageAggregator()
        cancellables = []
    }

    func testAssemblesChunksInOrder() {
        var result = ""
        let expectation = expectation(description: "stream complete")

        aggregator.assembledContent(for: "msg1")
            .sink { content in
                result = content
                if content.contains("完") {
                    expectation.fulfill()
                }
            }
            .store(in: &cancellables)

        let chunks = [
            ChatResponsePayload(sessionID: "s1", seq: 0, delta: "你好", done: false, full: nil),
            ChatResponsePayload(sessionID: "s1", seq: 1, delta: "，世界", done: false, full: nil),
            ChatResponsePayload(sessionID: "s1", seq: 2, delta: "完", done: true, full: "你好，世界完"),
        ]

        for chunk in chunks {
            aggregator.feed(messageID: "msg1", chunk: chunk)
        }

        wait(for: [expectation], timeout: 1.0)
        XCTAssertEqual(result, "你好，世界完")
    }

    func testHandlesOutOfOrderChunks() {
        var result = ""
        let expectation = expectation(description: "stream complete")

        aggregator.assembledContent(for: "msg2")
            .sink { content in
                result = content
                if content.contains("完") {
                    expectation.fulfill()
                }
            }
            .store(in: &cancellables)

        // Send seq 1 before seq 0
        aggregator.feed(messageID: "msg2", chunk:
            ChatResponsePayload(sessionID: "s1", seq: 1, delta: "世界", done: false, full: nil))
        aggregator.feed(messageID: "msg2", chunk:
            ChatResponsePayload(sessionID: "s1", seq: 0, delta: "你好", done: false, full: nil))
        aggregator.feed(messageID: "msg2", chunk:
            ChatResponsePayload(sessionID: "s1", seq: 2, delta: "完", done: true, full: "你好世界完"))

        wait(for: [expectation], timeout: 1.0)
        // When done arrives with full content, use full as final truth
        XCTAssertEqual(result, "你好世界完")
    }

    func testUsesFullContentOnDone() {
        var result = ""
        let expectation = expectation(description: "done received")

        aggregator.assembledContent(for: "msg3")
            .sink { content in
                result = content
                if content == "完整内容" {
                    expectation.fulfill()
                }
            }
            .store(in: &cancellables)

        aggregator.feed(messageID: "msg3", chunk:
            ChatResponsePayload(sessionID: "s1", seq: 0, delta: "部分", done: false, full: nil))
        aggregator.feed(messageID: "msg3", chunk:
            ChatResponsePayload(sessionID: "s1", seq: 1, delta: "", done: true, full: "完整内容"))

        wait(for: [expectation], timeout: 1.0)
        XCTAssertEqual(result, "完整内容")
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Expected: Compilation error — `MessageAggregator` not defined

- [ ] **Step 3: Implement MessageAggregator**

```swift
// TeamClawMobile/Core/MessageAggregator.swift
import Foundation
import Combine

final class MessageAggregator {
    private var streams: [String: [Int: String]] = [:]
    private var subjects: [String: CurrentValueSubject<String, Never>] = [:]

    func assembledContent(for messageID: String) -> AnyPublisher<String, Never> {
        if subjects[messageID] == nil {
            subjects[messageID] = CurrentValueSubject("")
            streams[messageID] = [:]
        }
        return subjects[messageID]!.eraseToAnyPublisher()
    }

    func feed(messageID: String, chunk: ChatResponsePayload) {
        if subjects[messageID] == nil {
            subjects[messageID] = CurrentValueSubject("")
            streams[messageID] = [:]
        }

        streams[messageID]?[chunk.seq] = chunk.delta

        if chunk.done, let full = chunk.full {
            subjects[messageID]?.send(full)
            cleanup(messageID: messageID)
            return
        }

        // Assemble in-order content from seq 0
        let assembled = assembleInOrder(messageID: messageID)
        subjects[messageID]?.send(assembled)
    }

    func reset(messageID: String) {
        cleanup(messageID: messageID)
    }

    private func assembleInOrder(messageID: String) -> String {
        guard let chunks = streams[messageID] else { return "" }
        var result = ""
        var seq = 0
        while let delta = chunks[seq] {
            result += delta
            seq += 1
        }
        return result
    }

    private func cleanup(messageID: String) {
        streams.removeValue(forKey: messageID)
        // Keep subject alive for final value delivery
    }
}
```

- [ ] **Step 4: Run MessageAggregator tests**

Expected: All 3 tests PASS

- [ ] **Step 5: Write ConnectionMonitor tests**

```swift
// TeamClawMobileTests/Core/ConnectionMonitorTests.swift
import XCTest
import Combine
@testable import TeamClawMobile

final class ConnectionMonitorTests: XCTestCase {
    var monitor: ConnectionMonitor!
    var mockMQTT: MockMQTTService!
    var cancellables: Set<AnyCancellable>!

    override func setUp() {
        mockMQTT = MockMQTTService()
        monitor = ConnectionMonitor(mqttService: mockMQTT)
        cancellables = []
    }

    func testInitiallyOffline() {
        XCTAssertFalse(monitor.isDesktopOnline)
    }

    func testGoesOnlineOnStatusMessage() {
        let expectation = expectation(description: "online")

        monitor.$isDesktopOnline
            .dropFirst()
            .first(where: { $0 })
            .sink { _ in expectation.fulfill() }
            .store(in: &cancellables)

        let msg = MQTTMessage(
            id: "status1",
            type: .status,
            timestamp: Date().timeIntervalSince1970,
            payload: .status(StatusPayload(online: true, deviceName: "MacBook Pro"))
        )
        mockMQTT.simulateMessage(msg)

        wait(for: [expectation], timeout: 1.0)
        XCTAssertTrue(monitor.isDesktopOnline)
        XCTAssertEqual(monitor.desktopDeviceName, "MacBook Pro")
    }

    func testGoesOfflineOnStatusMessage() {
        // First go online
        let onlineMsg = MQTTMessage(
            id: "s1", type: .status, timestamp: 0,
            payload: .status(StatusPayload(online: true, deviceName: "Mac"))
        )
        mockMQTT.simulateMessage(onlineMsg)

        let expectation = expectation(description: "offline")

        monitor.$isDesktopOnline
            .dropFirst()
            .first(where: { !$0 })
            .sink { _ in expectation.fulfill() }
            .store(in: &cancellables)

        let offlineMsg = MQTTMessage(
            id: "s2", type: .status, timestamp: 1,
            payload: .status(StatusPayload(online: false, deviceName: nil))
        )
        mockMQTT.simulateMessage(offlineMsg)

        wait(for: [expectation], timeout: 1.0)
        XCTAssertFalse(monitor.isDesktopOnline)
    }
}
```

- [ ] **Step 6: Implement ConnectionMonitor**

```swift
// TeamClawMobile/Core/ConnectionMonitor.swift
import Foundation
import Combine

final class ConnectionMonitor: ObservableObject {
    @Published var isDesktopOnline = false
    @Published var desktopDeviceName: String?

    private var cancellables = Set<AnyCancellable>()

    init(mqttService: MQTTServiceProtocol) {
        mqttService.receivedMessage
            .compactMap { msg -> StatusPayload? in
                if case .status(let payload) = msg.payload {
                    return payload
                }
                return nil
            }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] payload in
                self?.isDesktopOnline = payload.online
                self?.desktopDeviceName = payload.deviceName
            }
            .store(in: &cancellables)
    }
}
```

- [ ] **Step 7: Run all tests**

Expected: All MessageAggregator + ConnectionMonitor tests PASS

- [ ] **Step 8: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/Core/MessageAggregator.swift \
       TeamClawMobile/TeamClawMobile/Core/ConnectionMonitor.swift \
       TeamClawMobileTests/Core/
git commit -m "feat(mobile): add MessageAggregator for streaming and ConnectionMonitor for desktop status"
```

---

### Task 5: Shared UI Components

**Files:**
- Create: `TeamClawMobile/TeamClawMobile/Shared/DesktopStatusBadge.swift`
- Create: `TeamClawMobile/TeamClawMobile/Shared/LiquidGlassBar.swift`
- Create: `TeamClawMobile/TeamClawMobile/Shared/MarkdownRenderer.swift`

- [ ] **Step 1: Implement DesktopStatusBadge**

```swift
// TeamClawMobile/Shared/DesktopStatusBadge.swift
import SwiftUI

struct DesktopStatusBadge: View {
    let isOnline: Bool
    let deviceName: String?

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(isOnline ? Color.green : Color.red)
                .frame(width: 8, height: 8)
            Text(isOnline ? (deviceName ?? "桌面端在线") : "桌面端离线")
                .font(.caption2)
                .foregroundStyle(isOnline ? .secondary : .red)
        }
    }
}

#Preview {
    VStack(spacing: 12) {
        DesktopStatusBadge(isOnline: true, deviceName: "MacBook Pro")
        DesktopStatusBadge(isOnline: false, deviceName: nil)
    }
}
```

- [ ] **Step 2: Implement LiquidGlassBar**

```swift
// TeamClawMobile/Shared/LiquidGlassBar.swift
import SwiftUI

struct LiquidGlassBar<Content: View>: View {
    let content: () -> Content

    init(@ViewBuilder content: @escaping () -> Content) {
        self.content = content
    }

    var body: some View {
        content()
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20))
            .shadow(color: .black.opacity(0.08), radius: 8, y: 4)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
    }
}

#Preview {
    ZStack(alignment: .bottom) {
        Color.gray.opacity(0.1).ignoresSafeArea()
        LiquidGlassBar {
            HStack {
                Image(systemName: "magnifyingglass")
                Spacer()
                Image(systemName: "plus")
            }
            .font(.title2)
            .foregroundStyle(.blue)
        }
    }
}
```

- [ ] **Step 3: Implement MarkdownRenderer**

```swift
// TeamClawMobile/Shared/MarkdownRenderer.swift
import SwiftUI
import Markdown

struct MarkdownRenderer: View {
    let content: String

    var body: some View {
        if #available(iOS 17.0, *) {
            // Use AttributedString for rich rendering
            Text(attributedContent)
                .textSelection(.enabled)
        } else {
            // Fallback for iOS 16
            Text(LocalizedStringKey(content))
                .textSelection(.enabled)
        }
    }

    @available(iOS 17.0, *)
    private var attributedContent: AttributedString {
        do {
            return try AttributedString(markdown: content, options: .init(
                allowsExtendedAttributes: true,
                interpretedSyntax: .inlineOnlyPreservingWhitespace
            ))
        } catch {
            return AttributedString(content)
        }
    }
}

#Preview {
    ScrollView {
        MarkdownRenderer(content: """
        **用户增长**
        - DAU 环比上升 12%
        - 新注册用户 340 人

        ```
        付费转化: 3.2% → 4.1%
        ```

        > 这是一段引用
        """)
        .padding()
    }
}
```

- [ ] **Step 4: Verify build succeeds**

Run: Cmd+B
Expected: BUILD SUCCEEDED

- [ ] **Step 5: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/Shared/
git commit -m "feat(mobile): add shared UI components - status badge, liquid glass bar, markdown renderer"
```

---

### Task 6: Session List (Home Page)

**Files:**
- Create: `TeamClawMobile/TeamClawMobile/Features/SessionList/SessionListView.swift`
- Create: `TeamClawMobile/TeamClawMobile/Features/SessionList/SessionListViewModel.swift`
- Create: `TeamClawMobileTests/Features/SessionListViewModelTests.swift`

- [ ] **Step 1: Write ViewModel tests**

```swift
// TeamClawMobileTests/Features/SessionListViewModelTests.swift
import XCTest
import SwiftData
import Combine
@testable import TeamClawMobile

final class SessionListViewModelTests: XCTestCase {
    var viewModel: SessionListViewModel!
    var mockMQTT: MockMQTTService!
    var container: ModelContainer!
    var context: ModelContext!

    override func setUp() {
        let config = ModelConfiguration(isStoredInMemoryOnly: true)
        container = try! ModelContainer(
            for: Session.self, ChatMessage.self, TeamMember.self, AutomationTask.self, Skill.self,
            configurations: config
        )
        context = ModelContext(container)
        mockMQTT = MockMQTTService()
        viewModel = SessionListViewModel(modelContext: context, mqttService: mockMQTT)
    }

    func testSessionsSortedByLastMessageTime() {
        let old = Session(
            id: "s1", title: "旧的", agentName: "Agent",
            agentAvatarURL: nil, lastMessageContent: "旧消息",
            lastMessageTime: Date(timeIntervalSinceNow: -3600),
            isCollaborative: false, collaboratorIDs: []
        )
        let new = Session(
            id: "s2", title: "新的", agentName: "Agent",
            agentAvatarURL: nil, lastMessageContent: "新消息",
            lastMessageTime: Date(),
            isCollaborative: false, collaboratorIDs: []
        )
        context.insert(old)
        context.insert(new)
        try! context.save()

        viewModel.loadSessions()

        XCTAssertEqual(viewModel.sessions.count, 2)
        XCTAssertEqual(viewModel.sessions.first?.title, "新的")
    }

    func testSearchFiltersSessions() {
        let s1 = Session(
            id: "s1", title: "运营搭档", agentName: "运营",
            agentAvatarURL: nil, lastMessageContent: "日报",
            lastMessageTime: Date(), isCollaborative: false, collaboratorIDs: []
        )
        let s2 = Session(
            id: "s2", title: "代码搭档", agentName: "代码",
            agentAvatarURL: nil, lastMessageContent: "PR",
            lastMessageTime: Date(), isCollaborative: false, collaboratorIDs: []
        )
        context.insert(s1)
        context.insert(s2)
        try! context.save()

        viewModel.loadSessions()
        viewModel.searchText = "运营"
        viewModel.applySearch()

        XCTAssertEqual(viewModel.filteredSessions.count, 1)
        XCTAssertEqual(viewModel.filteredSessions.first?.title, "运营搭档")
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Expected: Compilation error — ViewModel not defined

- [ ] **Step 3: Implement SessionListViewModel**

```swift
// TeamClawMobile/Features/SessionList/SessionListViewModel.swift
import Foundation
import SwiftData
import Combine

@MainActor
final class SessionListViewModel: ObservableObject {
    @Published var sessions: [Session] = []
    @Published var filteredSessions: [Session] = []
    @Published var searchText = ""

    private let modelContext: ModelContext
    private let mqttService: MQTTServiceProtocol

    init(modelContext: ModelContext, mqttService: MQTTServiceProtocol) {
        self.modelContext = modelContext
        self.mqttService = mqttService
    }

    func loadSessions() {
        let descriptor = FetchDescriptor<Session>(
            sortBy: [SortDescriptor(\.lastMessageTime, order: .reverse)]
        )
        sessions = (try? modelContext.fetch(descriptor)) ?? []
        applySearch()
    }

    func applySearch() {
        if searchText.isEmpty {
            filteredSessions = sessions
        } else {
            filteredSessions = sessions.filter {
                $0.title.localizedCaseInsensitiveContains(searchText) ||
                $0.lastMessageContent.localizedCaseInsensitiveContains(searchText)
            }
        }
    }

    func deleteSession(_ session: Session) {
        modelContext.delete(session)
        try? modelContext.save()
        loadSessions()
    }

    func relativeTime(for date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Expected: All SessionListViewModel tests PASS

- [ ] **Step 5: Implement SessionListView**

```swift
// TeamClawMobile/Features/SessionList/SessionListView.swift
import SwiftUI
import SwiftData

struct SessionListView: View {
    @Environment(\.modelContext) private var modelContext
    @StateObject private var viewModel: SessionListViewModel
    @ObservedObject var connectionMonitor: ConnectionMonitor

    @State private var showFunctionPanel = false
    @State private var showMemberPanel = false
    @State private var showSearch = false

    init(mqttService: MQTTServiceProtocol, connectionMonitor: ConnectionMonitor) {
        self._viewModel = StateObject(wrappedValue: SessionListViewModel(
            modelContext: ModelContext(try! ModelContainer(for: Session.self)),
            mqttService: mqttService
        ))
        self.connectionMonitor = connectionMonitor
    }

    // Workaround init for proper modelContext injection
    init(viewModel: SessionListViewModel, connectionMonitor: ConnectionMonitor) {
        self._viewModel = StateObject(wrappedValue: viewModel)
        self.connectionMonitor = connectionMonitor
    }

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottom) {
                List {
                    ForEach(viewModel.filteredSessions, id: \.id) { session in
                        NavigationLink(value: session.id) {
                            SessionRowView(session: session, viewModel: viewModel)
                        }
                    }
                    .onDelete { indexSet in
                        for index in indexSet {
                            viewModel.deleteSession(viewModel.filteredSessions[index])
                        }
                    }
                }
                .listStyle(.plain)

                // Bottom floating bar (Liquid Glass)
                LiquidGlassBar {
                    HStack {
                        Button(action: { showSearch.toggle() }) {
                            Image(systemName: "magnifyingglass")
                                .font(.title3)
                        }
                        Spacer()
                        Button(action: { /* create new session */ }) {
                            Image(systemName: "plus")
                                .font(.title3)
                        }
                    }
                }
            }
            .navigationTitle("Session")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(action: { showFunctionPanel = true }) {
                        Image(systemName: "line.3.horizontal")
                    }
                }
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 2) {
                        Text("Session")
                            .font(.headline)
                        DesktopStatusBadge(
                            isOnline: connectionMonitor.isDesktopOnline,
                            deviceName: connectionMonitor.desktopDeviceName
                        )
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: { showMemberPanel = true }) {
                        Image(systemName: "person.2")
                    }
                }
            }
            .navigationDestination(for: String.self) { sessionID in
                // ChatDetailView will go here
                Text("Chat: \(sessionID)")
            }
            .sheet(isPresented: $showFunctionPanel) {
                Text("Function Panel") // Task 10 replaces this
            }
            .sheet(isPresented: $showMemberPanel) {
                Text("Member Panel") // Task 11 replaces this
            }
            .sheet(isPresented: $showSearch) {
                SearchView(searchText: $viewModel.searchText, onSearch: viewModel.applySearch)
            }
        }
        .onAppear { viewModel.loadSessions() }
    }
}

// MARK: - Session Row

struct SessionRowView: View {
    let session: Session
    let viewModel: SessionListViewModel

    var body: some View {
        HStack(spacing: 12) {
            // Agent avatar
            Circle()
                .fill(Color.blue.opacity(0.15))
                .frame(width: 48, height: 48)
                .overlay(
                    Text(String(session.agentName.prefix(1)))
                        .font(.title3.bold())
                        .foregroundStyle(.blue)
                )

            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(session.title)
                        .font(.body.weight(.semibold))
                        .lineLimit(1)

                    if session.isCollaborative {
                        // Show collaborator count
                        Image(systemName: "person.2.fill")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    Spacer()

                    Text(viewModel.relativeTime(for: session.lastMessageTime))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Text(session.lastMessageContent)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Search Sheet

struct SearchView: View {
    @Binding var searchText: String
    let onSearch: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack {
                TextField("搜索 Session...", text: $searchText)
                    .textFieldStyle(.roundedBorder)
                    .padding()
                    .onChange(of: searchText) { _ in onSearch() }
                Spacer()
            }
            .navigationTitle("搜索")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") {
                        dismiss()
                    }
                }
            }
        }
    }
}
```

- [ ] **Step 6: Verify build succeeds**

Run: Cmd+B
Expected: BUILD SUCCEEDED

- [ ] **Step 7: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/Features/SessionList/ TeamClawMobileTests/Features/
git commit -m "feat(mobile): add Session List home page with iMessage-style layout and search"
```

---

### Task 7: Chat Detail View & Message Bubbles

**Files:**
- Create: `TeamClawMobile/TeamClawMobile/Features/Chat/ChatDetailView.swift`
- Create: `TeamClawMobile/TeamClawMobile/Features/Chat/ChatDetailViewModel.swift`
- Create: `TeamClawMobile/TeamClawMobile/Features/Chat/MessageBubbleView.swift`
- Create: `TeamClawMobile/TeamClawMobile/Features/Chat/StreamingTextView.swift`
- Create: `TeamClawMobile/TeamClawMobile/Features/Chat/ChatInputBar.swift`
- Create: `TeamClawMobileTests/Features/ChatDetailViewModelTests.swift`

- [ ] **Step 1: Write ChatDetailViewModel tests**

```swift
// TeamClawMobileTests/Features/ChatDetailViewModelTests.swift
import XCTest
import SwiftData
import Combine
@testable import TeamClawMobile

final class ChatDetailViewModelTests: XCTestCase {
    var viewModel: ChatDetailViewModel!
    var mockMQTT: MockMQTTService!
    var container: ModelContainer!
    var context: ModelContext!
    var cancellables: Set<AnyCancellable>!

    override func setUp() {
        let config = ModelConfiguration(isStoredInMemoryOnly: true)
        container = try! ModelContainer(
            for: Session.self, ChatMessage.self, TeamMember.self, AutomationTask.self, Skill.self,
            configurations: config
        )
        context = ModelContext(container)
        mockMQTT = MockMQTTService()
        cancellables = []

        let session = Session(
            id: "s1", title: "运营搭档", agentName: "运营",
            agentAvatarURL: nil, lastMessageContent: "",
            lastMessageTime: Date(), isCollaborative: false, collaboratorIDs: []
        )
        context.insert(session)
        try! context.save()

        viewModel = ChatDetailViewModel(
            sessionID: "s1",
            modelContext: context,
            mqttService: mockMQTT,
            aggregator: MessageAggregator()
        )
    }

    func testSendMessageCreatesUserMessage() {
        viewModel.inputText = "帮我做周报"
        viewModel.sendMessage()

        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages.first?.role, .user)
        XCTAssertEqual(viewModel.messages.first?.content, "帮我做周报")
        XCTAssertTrue(viewModel.inputText.isEmpty)
    }

    func testReceiveStreamingResponse() {
        let expectation = expectation(description: "streaming")

        viewModel.$streamingContent
            .dropFirst()
            .first(where: { $0.contains("你好") })
            .sink { _ in expectation.fulfill() }
            .store(in: &cancellables)

        let msg = MQTTMessage(
            id: "res1", type: .chatResponse, timestamp: Date().timeIntervalSince1970,
            payload: .chatResponse(ChatResponsePayload(
                sessionID: "s1", seq: 0, delta: "你好", done: false, full: nil
            ))
        )
        mockMQTT.simulateMessage(msg)

        wait(for: [expectation], timeout: 2.0)
    }

    func testCannotSendWhenDesktopOffline() {
        viewModel.isDesktopOnline = false
        viewModel.inputText = "test"
        viewModel.sendMessage()

        // Message should not be sent
        XCTAssertEqual(viewModel.messages.count, 0)
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Expected: Compilation errors

- [ ] **Step 3: Implement ChatDetailViewModel**

```swift
// TeamClawMobile/Features/Chat/ChatDetailViewModel.swift
import Foundation
import SwiftData
import Combine

@MainActor
final class ChatDetailViewModel: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var inputText = ""
    @Published var streamingContent = ""
    @Published var isStreaming = false
    @Published var isDesktopOnline = true
    @Published var selectedModel: String = "default"
    @Published var availableModels: [String] = ["default"]

    let sessionID: String
    private let modelContext: ModelContext
    private let mqttService: MQTTServiceProtocol
    private let aggregator: MessageAggregator
    private var cancellables = Set<AnyCancellable>()
    private var currentStreamMessageID: String?

    init(
        sessionID: String,
        modelContext: ModelContext,
        mqttService: MQTTServiceProtocol,
        aggregator: MessageAggregator
    ) {
        self.sessionID = sessionID
        self.modelContext = modelContext
        self.mqttService = mqttService
        self.aggregator = aggregator

        subscribeToMessages()
        loadMessages()
    }

    func loadMessages() {
        var descriptor = FetchDescriptor<ChatMessage>(
            predicate: #Predicate { $0.sessionID == self.sessionID },
            sortBy: [SortDescriptor(\.timestamp)]
        )
        // Workaround: fetch predicate with captured self doesn't work in all Swift versions
        // Use post-fetch filter as fallback
        let allDescriptor = FetchDescriptor<ChatMessage>(
            sortBy: [SortDescriptor(\.timestamp)]
        )
        let all = (try? modelContext.fetch(allDescriptor)) ?? []
        messages = all.filter { $0.sessionID == sessionID }
    }

    func sendMessage() {
        guard !inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        guard isDesktopOnline else { return }

        let msg = ChatMessage(
            id: UUID().uuidString,
            sessionID: sessionID,
            role: .user,
            content: inputText,
            timestamp: Date(),
            senderName: nil,
            isStreaming: false
        )
        modelContext.insert(msg)
        try? modelContext.save()
        messages.append(msg)

        let payload = ChatRequestPayload(
            sessionID: sessionID,
            content: inputText,
            imageURL: nil,
            model: selectedModel == "default" ? nil : selectedModel
        )
        let mqttMsg = MQTTMessage(
            id: UUID().uuidString,
            type: .chatRequest,
            timestamp: Date().timeIntervalSince1970,
            payload: .chatRequest(payload)
        )
        mqttService.publish(
            topic: "teamclaw/default/mobile/chat/req",
            message: mqttMsg,
            qos: 1
        )

        inputText = ""
    }

    func sendImageMessage(ossURL: String) {
        guard isDesktopOnline else { return }

        let msg = ChatMessage(
            id: UUID().uuidString,
            sessionID: sessionID,
            role: .user,
            content: "[图片]",
            timestamp: Date(),
            senderName: nil,
            isStreaming: false,
            imageURL: ossURL
        )
        modelContext.insert(msg)
        try? modelContext.save()
        messages.append(msg)

        let payload = ChatRequestPayload(
            sessionID: sessionID,
            content: "",
            imageURL: ossURL,
            model: selectedModel == "default" ? nil : selectedModel
        )
        let mqttMsg = MQTTMessage(
            id: UUID().uuidString,
            type: .chatRequest,
            timestamp: Date().timeIntervalSince1970,
            payload: .chatRequest(payload)
        )
        mqttService.publish(
            topic: "teamclaw/default/mobile/chat/req",
            message: mqttMsg,
            qos: 1
        )
    }

    private func subscribeToMessages() {
        mqttService.receivedMessage
            .compactMap { msg -> ChatResponsePayload? in
                if case .chatResponse(let payload) = msg.payload,
                   payload.sessionID == self.sessionID {
                    return payload
                }
                return nil
            }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] payload in
                self?.handleStreamChunk(payload)
            }
            .store(in: &cancellables)
    }

    private func handleStreamChunk(_ payload: ChatResponsePayload) {
        if currentStreamMessageID == nil {
            currentStreamMessageID = UUID().uuidString
            isStreaming = true
        }

        guard let msgID = currentStreamMessageID else { return }

        aggregator.feed(messageID: msgID, chunk: payload)

        aggregator.assembledContent(for: msgID)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] content in
                self?.streamingContent = content
            }
            .store(in: &cancellables)

        if payload.done {
            let finalContent = payload.full ?? streamingContent
            let aiMsg = ChatMessage(
                id: msgID,
                sessionID: sessionID,
                role: .assistant,
                content: finalContent,
                timestamp: Date(),
                senderName: nil,
                isStreaming: false
            )
            modelContext.insert(aiMsg)
            try? modelContext.save()
            messages.append(aiMsg)

            streamingContent = ""
            isStreaming = false
            currentStreamMessageID = nil
            aggregator.reset(messageID: msgID)
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Expected: All ChatDetailViewModel tests PASS

- [ ] **Step 5: Implement MessageBubbleView**

```swift
// TeamClawMobile/Features/Chat/MessageBubbleView.swift
import SwiftUI

struct MessageBubbleView: View {
    let message: ChatMessage

    var body: some View {
        switch message.role {
        case .user:
            userBubble
        case .assistant:
            aiBubble
        case .collaborator:
            collaboratorBubble
        }
    }

    // User message: right-aligned, brand color bubble, ~70% width
    private var userBubble: some View {
        HStack {
            Spacer(minLength: UIScreen.main.bounds.width * 0.3)
            VStack(alignment: .trailing, spacing: 4) {
                if let imageURL = message.imageURL {
                    AsyncImage(url: URL(string: imageURL)) { image in
                        image.resizable().scaledToFit()
                    } placeholder: {
                        ProgressView()
                    }
                    .frame(maxWidth: 200, maxHeight: 200)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                if !message.content.isEmpty && message.content != "[图片]" {
                    Text(message.content)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(Color.blue, in: RoundedRectangle(cornerRadius: 16))
                }
            }
        }
        .padding(.leading, 48)
    }

    // AI message: left-aligned, full width, light background, markdown
    private var aiBubble: some View {
        VStack(alignment: .leading, spacing: 4) {
            MarkdownRenderer(content: message.content)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.systemGray6), in: RoundedRectangle(cornerRadius: 16))
        }
    }

    // Collaborator message: left-aligned, green tint, with sender name
    private var collaboratorBubble: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let name = message.senderName {
                Text(name)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 14)
            }
            Text(message.content)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Color.green.opacity(0.12), in: RoundedRectangle(cornerRadius: 16))
        }
        .padding(.trailing, 48)
    }
}
```

- [ ] **Step 6: Implement StreamingTextView**

```swift
// TeamClawMobile/Features/Chat/StreamingTextView.swift
import SwiftUI

struct StreamingTextView: View {
    let content: String
    @State private var showCursor = true

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .bottom, spacing: 0) {
                MarkdownRenderer(content: content)
                if showCursor {
                    Text("█")
                        .foregroundStyle(.blue)
                        .font(.body)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.systemGray6), in: RoundedRectangle(cornerRadius: 16))
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 0.5).repeatForever()) {
                showCursor.toggle()
            }
        }
    }
}
```

- [ ] **Step 7: Implement ChatInputBar**

```swift
// TeamClawMobile/Features/Chat/ChatInputBar.swift
import SwiftUI
import PhotosUI

struct ChatInputBar: View {
    @Binding var text: String
    let isDisabled: Bool
    let selectedModel: String
    let onSend: () -> Void
    let onModelTap: () -> Void
    let onImageSelected: (UIImage) -> Void

    @State private var selectedPhoto: PhotosPickerItem?
    @State private var showCamera = false

    var body: some View {
        VStack(spacing: 8) {
            // Tool bar
            HStack(spacing: 16) {
                Button(action: onModelTap) {
                    Label(selectedModel, systemImage: "gearshape")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                PhotosPicker(selection: $selectedPhoto, matching: .images) {
                    Image(systemName: "paperclip")
                        .font(.body)
                        .foregroundStyle(.secondary)
                }
                .onChange(of: selectedPhoto) { newItem in
                    Task {
                        if let data = try? await newItem?.loadTransferable(type: Data.self),
                           let image = UIImage(data: data) {
                            onImageSelected(image)
                        }
                    }
                }

                Spacer()
            }
            .padding(.horizontal, 16)

            // Input field
            HStack(spacing: 8) {
                TextField(isDisabled ? "桌面端离线" : "输入消息...", text: $text)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(.systemGray6), in: RoundedRectangle(cornerRadius: 20))
                    .disabled(isDisabled)

                Button(action: onSend) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                        .foregroundStyle(text.isEmpty || isDisabled ? .gray : .blue)
                }
                .disabled(text.isEmpty || isDisabled)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
        }
        .background(.ultraThinMaterial)
    }
}
```

- [ ] **Step 8: Implement ChatDetailView**

```swift
// TeamClawMobile/Features/Chat/ChatDetailView.swift
import SwiftUI

struct ChatDetailView: View {
    @StateObject var viewModel: ChatDetailViewModel
    @ObservedObject var connectionMonitor: ConnectionMonitor
    @State private var showModelPicker = false

    var body: some View {
        VStack(spacing: 0) {
            // Messages
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(viewModel.messages, id: \.id) { message in
                            MessageBubbleView(message: message)
                                .id(message.id)
                        }

                        // Streaming message
                        if viewModel.isStreaming {
                            StreamingTextView(content: viewModel.streamingContent)
                                .id("streaming")
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
                .onChange(of: viewModel.messages.count) { _ in
                    withAnimation {
                        proxy.scrollTo(viewModel.messages.last?.id ?? "streaming", anchor: .bottom)
                    }
                }
                .onChange(of: viewModel.streamingContent) { _ in
                    withAnimation {
                        proxy.scrollTo("streaming", anchor: .bottom)
                    }
                }
            }

            // Input bar
            ChatInputBar(
                text: $viewModel.inputText,
                isDisabled: !connectionMonitor.isDesktopOnline,
                selectedModel: viewModel.selectedModel,
                onSend: { viewModel.sendMessage() },
                onModelTap: { showModelPicker = true },
                onImageSelected: { image in
                    // OSS upload handled in Task 8
                }
            )
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(viewModel.messages.first.map { _ in "Chat" } ?? "Chat")
                    .font(.headline)
            }
        }
        .sheet(isPresented: $showModelPicker) {
            ModelPickerView(
                models: viewModel.availableModels,
                selected: $viewModel.selectedModel
            )
        }
    }
}

// MARK: - Model Picker

struct ModelPickerView: View {
    let models: [String]
    @Binding var selected: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List(models, id: \.self) { model in
                Button(action: {
                    selected = model
                    dismiss()
                }) {
                    HStack {
                        Text(model)
                        Spacer()
                        if model == selected {
                            Image(systemName: "checkmark")
                                .foregroundStyle(.blue)
                        }
                    }
                }
            }
            .navigationTitle("选择模型")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
```

- [ ] **Step 9: Verify build succeeds and run tests**

Run: Cmd+B, then run tests
Expected: BUILD SUCCEEDED, all tests PASS

- [ ] **Step 10: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/Features/Chat/ TeamClawMobileTests/Features/ChatDetailViewModelTests.swift
git commit -m "feat(mobile): add chat detail view with streaming, message bubbles, input bar, and model picker"
```

---

### Task 8: OSS Image Upload

**Files:**
- Create: `TeamClawMobile/TeamClawMobile/Core/OSSUploader.swift`

- [ ] **Step 1: Implement OSSUploader**

```swift
// TeamClawMobile/Core/OSSUploader.swift
import Foundation
import UIKit
import Alamofire

final class OSSUploader {
    struct Config {
        let endpoint: String      // e.g. "https://bucket.oss-cn-hangzhou.aliyuncs.com"
        let accessKeyID: String
        let accessKeySecret: String
        let bucket: String
        let pathPrefix: String    // e.g. "mobile/images/"
    }

    private let config: Config

    init(config: Config) {
        self.config = config
    }

    func upload(image: UIImage, completion: @escaping (Result<String, Error>) -> Void) {
        guard let data = image.jpegData(compressionQuality: 0.8) else {
            completion(.failure(OSSError.compressionFailed))
            return
        }

        let filename = "\(config.pathPrefix)\(UUID().uuidString).jpg"
        let url = "\(config.endpoint)/\(filename)"

        // Simplified upload — in production, use STS token from desktop or pre-signed URL
        AF.upload(data, to: url, method: .put, headers: [
            "Content-Type": "image/jpeg"
        ])
        .validate(statusCode: 200..<300)
        .response { response in
            switch response.result {
            case .success:
                completion(.success(url))
            case .failure(let error):
                completion(.failure(error))
            }
        }
    }

    enum OSSError: LocalizedError {
        case compressionFailed

        var errorDescription: String? {
            switch self {
            case .compressionFailed: return "图片压缩失败"
            }
        }
    }
}
```

- [ ] **Step 2: Verify build succeeds**

Run: Cmd+B
Expected: BUILD SUCCEEDED

- [ ] **Step 3: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/Core/OSSUploader.swift
git commit -m "feat(mobile): add OSS image uploader for attachments"
```

---

### Task 9: Pairing Manager & Settings

**Files:**
- Create: `TeamClawMobile/TeamClawMobile/Core/PairingManager.swift`
- Create: `TeamClawMobile/TeamClawMobile/Features/Settings/SettingsView.swift`
- Create: `TeamClawMobile/TeamClawMobile/Features/Settings/PairingView.swift`
- Create: `TeamClawMobile/TeamClawMobile/Features/Settings/NotificationPrefView.swift`

- [ ] **Step 1: Implement PairingManager**

```swift
// TeamClawMobile/Core/PairingManager.swift
import Foundation

final class PairingManager: ObservableObject {
    @Published var isPaired = false
    @Published var pairedDeviceName: String?
    @Published var pairingError: String?

    private let defaults = UserDefaults.standard

    private enum Keys {
        static let isPaired = "teamclaw_is_paired"
        static let deviceName = "teamclaw_paired_device_name"
        static let mqttHost = "teamclaw_mqtt_host"
        static let mqttPort = "teamclaw_mqtt_port"
        static let mqttUsername = "teamclaw_mqtt_username"
        static let mqttPassword = "teamclaw_mqtt_password"
        static let teamID = "teamclaw_team_id"
        static let deviceID = "teamclaw_device_id"
    }

    struct PairingCredentials {
        let mqttHost: String
        let mqttPort: UInt16
        let mqttUsername: String
        let mqttPassword: String
        let teamID: String
        let deviceID: String
        let desktopDeviceName: String
    }

    init() {
        isPaired = defaults.bool(forKey: Keys.isPaired)
        pairedDeviceName = defaults.string(forKey: Keys.deviceName)
    }

    var credentials: PairingCredentials? {
        guard isPaired,
              let host = defaults.string(forKey: Keys.mqttHost),
              let username = defaults.string(forKey: Keys.mqttUsername),
              let password = defaults.string(forKey: Keys.mqttPassword),
              let teamID = defaults.string(forKey: Keys.teamID),
              let deviceID = defaults.string(forKey: Keys.deviceID)
        else { return nil }

        let port = defaults.integer(forKey: Keys.mqttPort)
        return PairingCredentials(
            mqttHost: host,
            mqttPort: UInt16(port > 0 ? port : 8883),
            mqttUsername: username,
            mqttPassword: password,
            teamID: teamID,
            deviceID: deviceID,
            desktopDeviceName: pairedDeviceName ?? ""
        )
    }

    func pair(with code: String) {
        // In V1, pairing code is exchanged manually.
        // The 6-digit code maps to a temporary MQTT topic where credentials are published.
        // For now, store placeholder credentials — real implementation requires desktop relay.
        pairingError = nil

        guard code.count == 6, code.allSatisfy(\.isNumber) else {
            pairingError = "请输入6位数字配对码"
            return
        }

        // TODO: Exchange code via temporary MQTT topic to get real credentials
        // For development, simulate successful pairing
        savePairing(PairingCredentials(
            mqttHost: "broker.teamclaw.com",
            mqttPort: 8883,
            mqttUsername: "mobile_\(UUID().uuidString.prefix(8))",
            mqttPassword: UUID().uuidString,
            teamID: "default",
            deviceID: UUID().uuidString,
            desktopDeviceName: "桌面端"
        ))
    }

    func unpair() {
        let keys = [Keys.isPaired, Keys.deviceName, Keys.mqttHost, Keys.mqttPort,
                    Keys.mqttUsername, Keys.mqttPassword, Keys.teamID, Keys.deviceID]
        keys.forEach { defaults.removeObject(forKey: $0) }
        isPaired = false
        pairedDeviceName = nil
    }

    private func savePairing(_ creds: PairingCredentials) {
        defaults.set(true, forKey: Keys.isPaired)
        defaults.set(creds.desktopDeviceName, forKey: Keys.deviceName)
        defaults.set(creds.mqttHost, forKey: Keys.mqttHost)
        defaults.set(Int(creds.mqttPort), forKey: Keys.mqttPort)
        defaults.set(creds.mqttUsername, forKey: Keys.mqttUsername)
        defaults.set(creds.mqttPassword, forKey: Keys.mqttPassword)
        defaults.set(creds.teamID, forKey: Keys.teamID)
        defaults.set(creds.deviceID, forKey: Keys.deviceID)
        isPaired = true
        pairedDeviceName = creds.desktopDeviceName
    }
}
```

- [ ] **Step 2: Implement PairingView**

```swift
// TeamClawMobile/Features/Settings/PairingView.swift
import SwiftUI

struct PairingView: View {
    @ObservedObject var pairingManager: PairingManager
    @State private var code = ""
    @FocusState private var isFocused: Bool

    var body: some View {
        VStack(spacing: 32) {
            Spacer()

            Image(systemName: "link.badge.plus")
                .font(.system(size: 64))
                .foregroundStyle(.blue)

            Text("连接桌面端")
                .font(.title2.bold())

            Text("在桌面端设置中生成配对码，\n然后在下方输入")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            TextField("000000", text: $code)
                .keyboardType(.numberPad)
                .font(.system(size: 32, weight: .bold, design: .monospaced))
                .multilineTextAlignment(.center)
                .frame(maxWidth: 200)
                .focused($isFocused)
                .onChange(of: code) { newValue in
                    // Limit to 6 digits
                    code = String(newValue.filter(\.isNumber).prefix(6))
                }

            if let error = pairingManager.pairingError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            Button(action: {
                pairingManager.pair(with: code)
            }) {
                Text("配对")
                    .font(.headline)
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(code.count == 6 ? Color.blue : Color.gray, in: RoundedRectangle(cornerRadius: 12))
            }
            .disabled(code.count != 6)
            .padding(.horizontal, 48)

            Spacer()
        }
        .padding()
        .onAppear { isFocused = true }
    }
}
```

- [ ] **Step 3: Implement SettingsView and NotificationPrefView**

```swift
// TeamClawMobile/Features/Settings/SettingsView.swift
import SwiftUI

struct SettingsView: View {
    @ObservedObject var pairingManager: PairingManager
    @ObservedObject var connectionMonitor: ConnectionMonitor

    var body: some View {
        NavigationStack {
            List {
                // Connection section
                Section("桌面端连接") {
                    HStack {
                        Text("状态")
                        Spacer()
                        DesktopStatusBadge(
                            isOnline: connectionMonitor.isDesktopOnline,
                            deviceName: connectionMonitor.desktopDeviceName
                        )
                    }

                    if pairingManager.isPaired {
                        HStack {
                            Text("已配对设备")
                            Spacer()
                            Text(pairingManager.pairedDeviceName ?? "未知")
                                .foregroundStyle(.secondary)
                        }

                        Button("解除配对", role: .destructive) {
                            pairingManager.unpair()
                        }
                    }
                }

                // Notifications
                Section {
                    NavigationLink("通知偏好") {
                        NotificationPrefView()
                    }
                }

                // About
                Section("关于") {
                    HStack {
                        Text("版本")
                        Spacer()
                        Text("1.0.0")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("设置")
        }
    }
}
```

```swift
// TeamClawMobile/Features/Settings/NotificationPrefView.swift
import SwiftUI

struct NotificationPrefView: View {
    @AppStorage("notify_chat") private var notifyChat = true
    @AppStorage("notify_task") private var notifyTask = true
    @AppStorage("notify_collab") private var notifyCollab = true

    var body: some View {
        List {
            Section("消息通知") {
                Toggle("Agent 对话回复", isOn: $notifyChat)
                Toggle("任务执行结果", isOn: $notifyTask)
                Toggle("协作 Session 消息", isOn: $notifyCollab)
            }
        }
        .navigationTitle("通知偏好")
    }
}
```

- [ ] **Step 4: Verify build succeeds**

Run: Cmd+B
Expected: BUILD SUCCEEDED

- [ ] **Step 5: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/Core/PairingManager.swift \
       TeamClawMobile/TeamClawMobile/Features/Settings/
git commit -m "feat(mobile): add device pairing flow and settings views"
```

---

### Task 10: Function Panel, Automation & Skills Pages

**Files:**
- Create: `TeamClawMobile/TeamClawMobile/Features/FunctionPanel/FunctionPanelView.swift`
- Create: `TeamClawMobile/TeamClawMobile/Features/Automation/TaskListView.swift`
- Create: `TeamClawMobile/TeamClawMobile/Features/Automation/TaskEditView.swift`
- Create: `TeamClawMobile/TeamClawMobile/Features/Automation/TaskViewModel.swift`
- Create: `TeamClawMobile/TeamClawMobile/Features/Skills/SkillHomeView.swift`
- Create: `TeamClawMobile/TeamClawMobile/Features/Skills/SkillViewModel.swift`
- Create: `TeamClawMobileTests/Features/TaskViewModelTests.swift`

- [ ] **Step 1: Write TaskViewModel tests**

```swift
// TeamClawMobileTests/Features/TaskViewModelTests.swift
import XCTest
import SwiftData
@testable import TeamClawMobile

final class TaskViewModelTests: XCTestCase {
    var viewModel: TaskViewModel!
    var container: ModelContainer!
    var context: ModelContext!
    var mockMQTT: MockMQTTService!

    override func setUp() {
        let config = ModelConfiguration(isStoredInMemoryOnly: true)
        container = try! ModelContainer(
            for: Session.self, ChatMessage.self, TeamMember.self, AutomationTask.self, Skill.self,
            configurations: config
        )
        context = ModelContext(container)
        mockMQTT = MockMQTTService()
        viewModel = TaskViewModel(modelContext: context, mqttService: mockMQTT)
    }

    func testAddTask() {
        viewModel.addTask(name: "日报", cron: "0 9 * * *", description: "每天生成日报")

        XCTAssertEqual(viewModel.tasks.count, 1)
        XCTAssertEqual(viewModel.tasks.first?.name, "日报")
        XCTAssertEqual(viewModel.tasks.first?.status, .idle)
    }

    func testDeleteTask() {
        viewModel.addTask(name: "日报", cron: "0 9 * * *", description: "test")
        XCTAssertEqual(viewModel.tasks.count, 1)

        viewModel.deleteTask(viewModel.tasks[0])
        XCTAssertEqual(viewModel.tasks.count, 0)
    }

    func testUpdateTask() {
        viewModel.addTask(name: "日报", cron: "0 9 * * *", description: "test")
        let task = viewModel.tasks[0]
        viewModel.updateTask(task, name: "周报", cron: "0 9 * * 1", description: "每周一生成")

        XCTAssertEqual(viewModel.tasks.first?.name, "周报")
        XCTAssertEqual(viewModel.tasks.first?.cronExpression, "0 9 * * 1")
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Expected: Compilation error — `TaskViewModel` not defined

- [ ] **Step 3: Implement TaskViewModel**

```swift
// TeamClawMobile/Features/Automation/TaskViewModel.swift
import Foundation
import SwiftData
import Combine

@MainActor
final class TaskViewModel: ObservableObject {
    @Published var tasks: [AutomationTask] = []

    private let modelContext: ModelContext
    private let mqttService: MQTTServiceProtocol
    private var cancellables = Set<AnyCancellable>()

    init(modelContext: ModelContext, mqttService: MQTTServiceProtocol) {
        self.modelContext = modelContext
        self.mqttService = mqttService
        loadTasks()
        subscribeToUpdates()
    }

    func loadTasks() {
        let descriptor = FetchDescriptor<AutomationTask>(
            sortBy: [SortDescriptor(\.name)]
        )
        tasks = (try? modelContext.fetch(descriptor)) ?? []
    }

    func addTask(name: String, cron: String, description: String) {
        let task = AutomationTask(
            id: UUID().uuidString,
            name: name,
            status: .idle,
            lastRunTime: nil,
            cronExpression: cron,
            description: description
        )
        modelContext.insert(task)
        try? modelContext.save()
        loadTasks()

        // Notify desktop
        let msg = MQTTMessage(
            id: UUID().uuidString,
            type: .taskUpdate,
            timestamp: Date().timeIntervalSince1970,
            payload: .taskUpdate(TaskUpdatePayload(
                taskID: task.id,
                status: "created",
                lastRunTime: nil
            ))
        )
        mqttService.publish(topic: "teamclaw/default/mobile/task", message: msg, qos: 1)
    }

    func deleteTask(_ task: AutomationTask) {
        modelContext.delete(task)
        try? modelContext.save()
        loadTasks()
    }

    func updateTask(_ task: AutomationTask, name: String, cron: String, description: String) {
        task.name = name
        task.cronExpression = cron
        task.taskDescription = description
        try? modelContext.save()
        loadTasks()
    }

    private func subscribeToUpdates() {
        mqttService.receivedMessage
            .compactMap { msg -> TaskUpdatePayload? in
                if case .taskUpdate(let payload) = msg.payload {
                    return payload
                }
                return nil
            }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] payload in
                self?.handleTaskUpdate(payload)
            }
            .store(in: &cancellables)
    }

    private func handleTaskUpdate(_ payload: TaskUpdatePayload) {
        guard let task = tasks.first(where: { $0.id == payload.taskID }) else { return }
        task.statusRaw = payload.status
        if let time = payload.lastRunTime {
            task.lastRunTime = Date(timeIntervalSince1970: time)
        }
        try? modelContext.save()
        loadTasks()
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Expected: All TaskViewModel tests PASS

- [ ] **Step 5: Implement TaskListView and TaskEditView**

```swift
// TeamClawMobile/Features/Automation/TaskListView.swift
import SwiftUI

struct TaskListView: View {
    @StateObject var viewModel: TaskViewModel
    @State private var showAddTask = false

    var body: some View {
        List {
            ForEach(viewModel.tasks, id: \.id) { task in
                NavigationLink {
                    TaskEditView(
                        viewModel: viewModel,
                        task: task,
                        isNew: false
                    )
                } label: {
                    TaskRowView(task: task)
                }
            }
            .onDelete { indexSet in
                for index in indexSet {
                    viewModel.deleteTask(viewModel.tasks[index])
                }
            }
        }
        .navigationTitle("自动化")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: { showAddTask = true }) {
                    Image(systemName: "plus")
                }
            }
        }
        .sheet(isPresented: $showAddTask) {
            NavigationStack {
                TaskEditView(
                    viewModel: viewModel,
                    task: nil,
                    isNew: true
                )
            }
        }
    }
}

struct TaskRowView: View {
    let task: AutomationTask

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(task.name)
                    .font(.body.weight(.medium))
                Text(task.cronExpression)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 4) {
                statusBadge
                if let lastRun = task.lastRunTime {
                    Text(lastRun, style: .relative)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var statusBadge: some View {
        let (text, color): (String, Color) = switch task.status {
        case .running: ("运行中", .blue)
        case .completed: ("已完成", .green)
        case .failed: ("失败", .red)
        case .idle: ("空闲", .secondary)
        }
        Text(text)
            .font(.caption)
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(color.opacity(0.1), in: Capsule())
    }
}
```

```swift
// TeamClawMobile/Features/Automation/TaskEditView.swift
import SwiftUI

struct TaskEditView: View {
    @ObservedObject var viewModel: TaskViewModel
    let task: AutomationTask?
    let isNew: Bool
    @Environment(\.dismiss) private var dismiss

    @State private var name: String = ""
    @State private var cron: String = ""
    @State private var description: String = ""

    var body: some View {
        Form {
            Section("任务信息") {
                TextField("任务名称", text: $name)
                TextField("Cron 表达式", text: $cron)
                    .font(.body.monospaced())
                TextField("描述", text: $description, axis: .vertical)
                    .lineLimit(3...6)
            }
        }
        .navigationTitle(isNew ? "新建任务" : "编辑任务")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("取消") { dismiss() }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("保存") {
                    if isNew {
                        viewModel.addTask(name: name, cron: cron, description: description)
                    } else if let task {
                        viewModel.updateTask(task, name: name, cron: cron, description: description)
                    }
                    dismiss()
                }
                .disabled(name.isEmpty || cron.isEmpty)
            }
        }
        .onAppear {
            if let task {
                name = task.name
                cron = task.cronExpression
                description = task.taskDescription
            }
        }
    }
}
```

- [ ] **Step 6: Implement SkillHomeView and SkillViewModel**

```swift
// TeamClawMobile/Features/Skills/SkillViewModel.swift
import Foundation
import SwiftData
import Combine

@MainActor
final class SkillViewModel: ObservableObject {
    @Published var personalSkills: [Skill] = []
    @Published var teamSkills: [Skill] = []

    private let modelContext: ModelContext
    private let mqttService: MQTTServiceProtocol
    private var cancellables = Set<AnyCancellable>()

    init(modelContext: ModelContext, mqttService: MQTTServiceProtocol) {
        self.modelContext = modelContext
        self.mqttService = mqttService
        loadSkills()
        subscribeToSync()
    }

    func loadSkills() {
        let descriptor = FetchDescriptor<Skill>(sortBy: [SortDescriptor(\.name)])
        let all = (try? modelContext.fetch(descriptor)) ?? []
        personalSkills = all.filter { $0.isPersonal }
        teamSkills = all.filter { !$0.isPersonal }
    }

    private func subscribeToSync() {
        mqttService.receivedMessage
            .compactMap { msg -> SkillSyncPayload? in
                if case .skillSync(let payload) = msg.payload {
                    return payload
                }
                return nil
            }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] payload in
                self?.handleSync(payload)
            }
            .store(in: &cancellables)
    }

    private func handleSync(_ payload: SkillSyncPayload) {
        // Replace all skills with synced data
        let descriptor = FetchDescriptor<Skill>()
        let existing = (try? modelContext.fetch(descriptor)) ?? []
        existing.forEach { modelContext.delete($0) }

        for data in payload.skills {
            let skill = Skill(
                id: data.id,
                name: data.name,
                description: data.description,
                isPersonal: data.isPersonal,
                isEnabled: data.isEnabled
            )
            modelContext.insert(skill)
        }
        try? modelContext.save()
        loadSkills()
    }
}
```

```swift
// TeamClawMobile/Features/Skills/SkillHomeView.swift
import SwiftUI

struct SkillHomeView: View {
    @StateObject var viewModel: SkillViewModel

    var body: some View {
        List {
            if !viewModel.personalSkills.isEmpty {
                Section("我的技能") {
                    ForEach(viewModel.personalSkills, id: \.id) { skill in
                        SkillRowView(skill: skill)
                    }
                }
            }

            if !viewModel.teamSkills.isEmpty {
                Section("团队技能") {
                    ForEach(viewModel.teamSkills, id: \.id) { skill in
                        SkillRowView(skill: skill)
                    }
                }
            }

            if viewModel.personalSkills.isEmpty && viewModel.teamSkills.isEmpty {
                ContentUnavailableView(
                    "暂无技能",
                    systemImage: "puzzlepiece",
                    description: Text("技能将从桌面端同步")
                )
            }
        }
        .navigationTitle("技能")
    }
}

struct SkillRowView: View {
    let skill: Skill

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(skill.name)
                    .font(.body.weight(.medium))
                Text(skill.skillDescription)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            Spacer()

            Circle()
                .fill(skill.isEnabled ? Color.green : Color.gray)
                .frame(width: 10, height: 10)
        }
        .padding(.vertical, 4)
    }
}
```

- [ ] **Step 7: Implement FunctionPanelView**

```swift
// TeamClawMobile/Features/FunctionPanel/FunctionPanelView.swift
import SwiftUI

struct FunctionPanelView: View {
    let mqttService: MQTTServiceProtocol
    let pairingManager: PairingManager
    let connectionMonitor: ConnectionMonitor
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Function entries
                List {
                    Section {
                        NavigationLink {
                            TaskListView(viewModel: TaskViewModel(
                                modelContext: modelContext,
                                mqttService: mqttService
                            ))
                        } label: {
                            Label("自动化", systemImage: "bolt.fill")
                                .foregroundStyle(.orange)
                        }

                        NavigationLink {
                            SkillHomeView(viewModel: SkillViewModel(
                                modelContext: modelContext,
                                mqttService: mqttService
                            ))
                        } label: {
                            Label("技能", systemImage: "puzzlepiece.fill")
                                .foregroundStyle(.purple)
                        }
                    }
                }
                .listStyle(.insetGrouped)

                Spacer()

                // Profile + Settings
                NavigationLink {
                    SettingsView(
                        pairingManager: pairingManager,
                        connectionMonitor: connectionMonitor
                    )
                } label: {
                    HStack(spacing: 12) {
                        Circle()
                            .fill(Color.blue.opacity(0.15))
                            .frame(width: 40, height: 40)
                            .overlay(
                                Image(systemName: "person.fill")
                                    .foregroundStyle(.blue)
                            )
                        VStack(alignment: .leading) {
                            Text("个人设置")
                                .font(.body)
                            Text("配对 · 通知 · 关于")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "chevron.right")
                            .foregroundStyle(.secondary)
                    }
                    .padding()
                }
            }
            .navigationTitle("功能")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                }
            }
        }
    }
}
```

- [ ] **Step 8: Run all tests and verify build**

Expected: BUILD SUCCEEDED, all tests PASS

- [ ] **Step 9: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/Features/FunctionPanel/ \
       TeamClawMobile/TeamClawMobile/Features/Automation/ \
       TeamClawMobile/TeamClawMobile/Features/Skills/ \
       TeamClawMobileTests/Features/TaskViewModelTests.swift
git commit -m "feat(mobile): add function panel, automation CRUD, and skills page"
```

---

### Task 11: Team Members Panel

**Files:**
- Create: `TeamClawMobile/TeamClawMobile/Features/TeamMembers/MemberListView.swift`
- Create: `TeamClawMobile/TeamClawMobile/Features/TeamMembers/MemberSessionsView.swift`
- Create: `TeamClawMobile/TeamClawMobile/Features/TeamMembers/MemberViewModel.swift`

- [ ] **Step 1: Implement MemberViewModel**

```swift
// TeamClawMobile/Features/TeamMembers/MemberViewModel.swift
import Foundation
import SwiftData
import Combine

@MainActor
final class MemberViewModel: ObservableObject {
    @Published var members: [TeamMember] = []

    private let modelContext: ModelContext
    private let mqttService: MQTTServiceProtocol
    private var cancellables = Set<AnyCancellable>()

    init(modelContext: ModelContext, mqttService: MQTTServiceProtocol) {
        self.modelContext = modelContext
        self.mqttService = mqttService
        loadMembers()
        subscribeToSync()
    }

    func loadMembers() {
        let descriptor = FetchDescriptor<TeamMember>(sortBy: [SortDescriptor(\.name)])
        members = (try? modelContext.fetch(descriptor)) ?? []
    }

    func collaborativeSessions(for member: TeamMember) -> [Session] {
        let descriptor = FetchDescriptor<Session>(
            sortBy: [SortDescriptor(\.lastMessageTime, order: .reverse)]
        )
        let all = (try? modelContext.fetch(descriptor)) ?? []
        return all.filter { $0.isCollaborative && $0.collaboratorIDs.contains(member.id) }
    }

    private func subscribeToSync() {
        mqttService.receivedMessage
            .compactMap { msg -> MemberSyncPayload? in
                if case .memberSync(let payload) = msg.payload {
                    return payload
                }
                return nil
            }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] payload in
                self?.handleSync(payload)
            }
            .store(in: &cancellables)
    }

    private func handleSync(_ payload: MemberSyncPayload) {
        let descriptor = FetchDescriptor<TeamMember>()
        let existing = (try? modelContext.fetch(descriptor)) ?? []
        existing.forEach { modelContext.delete($0) }

        for data in payload.members {
            let member = TeamMember(
                id: data.id,
                name: data.name,
                avatarURL: data.avatarURL,
                note: data.note
            )
            modelContext.insert(member)
        }
        try? modelContext.save()
        loadMembers()
    }
}
```

- [ ] **Step 2: Implement MemberListView**

```swift
// TeamClawMobile/Features/TeamMembers/MemberListView.swift
import SwiftUI

struct MemberListView: View {
    @StateObject var viewModel: MemberViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if viewModel.members.isEmpty {
                    ContentUnavailableView(
                        "暂无团队成员",
                        systemImage: "person.2",
                        description: Text("成员信息将从桌面端同步")
                    )
                } else {
                    ForEach(viewModel.members, id: \.id) { member in
                        NavigationLink {
                            MemberSessionsView(
                                member: member,
                                viewModel: viewModel
                            )
                        } label: {
                            MemberRowView(member: member)
                        }
                    }
                }
            }
            .navigationTitle("团队成员")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                }
            }
        }
    }
}

struct MemberRowView: View {
    let member: TeamMember

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(Color.purple.opacity(0.15))
                .frame(width: 40, height: 40)
                .overlay(
                    Text(String(member.name.prefix(1)))
                        .font(.body.bold())
                        .foregroundStyle(.purple)
                )

            VStack(alignment: .leading, spacing: 2) {
                Text(member.name)
                    .font(.body.weight(.medium))
                if let note = member.note, !note.isEmpty {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}
```

- [ ] **Step 3: Implement MemberSessionsView**

```swift
// TeamClawMobile/Features/TeamMembers/MemberSessionsView.swift
import SwiftUI

struct MemberSessionsView: View {
    let member: TeamMember
    @ObservedObject var viewModel: MemberViewModel

    var body: some View {
        List {
            let sessions = viewModel.collaborativeSessions(for: member)

            if !sessions.isEmpty {
                Section("与 \(member.name) 的协作 Session") {
                    ForEach(sessions, id: \.id) { session in
                        NavigationLink(value: session.id) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(session.title)
                                    .font(.body.weight(.medium))
                                Text(session.lastMessageContent)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                    }
                }
            }

            Section {
                Button(action: {
                    // Create new collaborative session with this member
                    // Will be connected to real MQTT flow when desktop relay exists
                }) {
                    Label("新建协作 Session", systemImage: "plus.bubble")
                }
            }
        }
        .navigationTitle(member.name)
    }
}
```

- [ ] **Step 4: Verify build succeeds**

Run: Cmd+B
Expected: BUILD SUCCEEDED

- [ ] **Step 5: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/Features/TeamMembers/
git commit -m "feat(mobile): add team members panel with collaborative session browsing"
```

---

### Task 12: Wire Up App Entry Point & Navigation

**Files:**
- Modify: `TeamClawMobile/TeamClawMobile/App/TeamClawMobileApp.swift`
- Modify: `TeamClawMobile/TeamClawMobile/App/ContentView.swift`

- [ ] **Step 1: Update TeamClawMobileApp with dependency injection**

```swift
// TeamClawMobile/App/TeamClawMobileApp.swift
import SwiftUI
import SwiftData

@main
struct TeamClawMobileApp: App {
    @StateObject private var pairingManager = PairingManager()

    var body: some Scene {
        WindowGroup {
            ContentView(pairingManager: pairingManager)
        }
        .modelContainer(for: [
            Session.self,
            ChatMessage.self,
            TeamMember.self,
            AutomationTask.self,
            Skill.self
        ])
    }
}
```

- [ ] **Step 2: Update ContentView as root navigator**

```swift
// TeamClawMobile/App/ContentView.swift
import SwiftUI

struct ContentView: View {
    @ObservedObject var pairingManager: PairingManager

    // Use mock for development until broker exists
    @StateObject private var mqttService = MockMQTTService()
    @StateObject private var connectionMonitor: ConnectionMonitor

    init(pairingManager: PairingManager) {
        self.pairingManager = pairingManager
        let mqtt = MockMQTTService()
        self._mqttService = StateObject(wrappedValue: mqtt)
        self._connectionMonitor = StateObject(wrappedValue: ConnectionMonitor(mqttService: mqtt))
    }

    var body: some View {
        Group {
            if pairingManager.isPaired {
                SessionListView(
                    mqttService: mqttService,
                    connectionMonitor: connectionMonitor
                )
            } else {
                PairingView(pairingManager: pairingManager)
            }
        }
    }
}
```

- [ ] **Step 3: Update SessionListView to use proper modelContext injection**

In `SessionListView.swift`, update the sheet presentations to pass real dependencies:

```swift
// Replace the placeholder sheets in SessionListView:
.sheet(isPresented: $showFunctionPanel) {
    FunctionPanelView(
        mqttService: mqttService,
        pairingManager: pairingManager,
        connectionMonitor: connectionMonitor
    )
}
.sheet(isPresented: $showMemberPanel) {
    MemberListView(viewModel: MemberViewModel(
        modelContext: modelContext,
        mqttService: mqttService
    ))
}
```

Note: `SessionListView` will need `pairingManager` and `mqttService` injected. Add these as stored properties and update the init.

- [ ] **Step 4: Update SessionListView navigationDestination for ChatDetailView**

```swift
// Replace the placeholder in SessionListView:
.navigationDestination(for: String.self) { sessionID in
    ChatDetailView(
        viewModel: ChatDetailViewModel(
            sessionID: sessionID,
            modelContext: modelContext,
            mqttService: mqttService,
            aggregator: MessageAggregator()
        ),
        connectionMonitor: connectionMonitor
    )
}
```

- [ ] **Step 5: Build and run in Simulator**

Run: Cmd+R on iPhone 16 simulator
Expected: App launches → shows PairingView (since not paired)

- [ ] **Step 6: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/App/
git commit -m "feat(mobile): wire up root navigation with pairing gate and dependency injection"
```

---

### Task 13: Real MQTT Service (CocoaMQTT)

**Files:**
- Create: `TeamClawMobile/TeamClawMobile/Core/MQTT/MQTTService.swift`

- [ ] **Step 1: Implement real MQTTService**

```swift
// TeamClawMobile/Core/MQTT/MQTTService.swift
import Foundation
import Combine
import CocoaMQTT

final class MQTTService: NSObject, MQTTServiceProtocol {
    private var mqtt: CocoaMQTT5?
    private let connectedSubject = CurrentValueSubject<Bool, Never>(false)
    private let messageSubject = PassthroughSubject<MQTTMessage, Never>()
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    var isConnected: AnyPublisher<Bool, Never> { connectedSubject.eraseToAnyPublisher() }
    var receivedMessage: AnyPublisher<MQTTMessage, Never> { messageSubject.eraseToAnyPublisher() }

    func connect(host: String, port: UInt16, username: String, password: String) {
        let clientID = "teamclaw-ios-\(UUID().uuidString.prefix(8))"
        let mqtt = CocoaMQTT5(clientID: clientID, host: host, port: port)
        mqtt.username = username
        mqtt.password = password
        mqtt.enableSSL = true
        mqtt.cleanSession = false
        mqtt.keepAlive = 60
        mqtt.delegate = self
        mqtt.autoReconnect = true
        mqtt.autoReconnectTimeInterval = 5
        self.mqtt = mqtt
        _ = mqtt.connect()
    }

    func disconnect() {
        mqtt?.disconnect()
    }

    func subscribe(topic: String, qos: Int) {
        let mqttQoS = CocoaMQTTQoS(rawValue: UInt8(qos)) ?? .qos1
        mqtt?.subscribe(topic, qos: mqttQoS)
    }

    func publish(topic: String, message: MQTTMessage, qos: Int) {
        guard let data = try? encoder.encode(message),
              let jsonString = String(data: data, encoding: .utf8) else { return }
        let mqttQoS = CocoaMQTTQoS(rawValue: UInt8(qos)) ?? .qos1
        mqtt?.publish(topic, withString: jsonString, qos: mqttQoS, retained: false)
    }
}

extension MQTTService: CocoaMQTT5Delegate {
    func mqtt5(_ mqtt5: CocoaMQTT5, didConnectAck ack: CocoaMQTTCONNACKReasonCode, connAckData: MqttDecodeConnAck?) {
        if ack == .success {
            connectedSubject.send(true)
        }
    }

    func mqtt5(_ mqtt5: CocoaMQTT5, didPublishMessage message: CocoaMQTT5Message, id: UInt16) {}

    func mqtt5(_ mqtt5: CocoaMQTT5, didPublishAck id: UInt16, pubAckData: MqttDecodePubAck?) {}

    func mqtt5(_ mqtt5: CocoaMQTT5, didReceiveMessage message: CocoaMQTT5Message, id: UInt16, publishData: MqttDecodePublish?) {
        guard let data = message.string?.data(using: .utf8),
              let mqttMessage = try? decoder.decode(MQTTMessage.self, from: data) else { return }
        messageSubject.send(mqttMessage)
    }

    func mqtt5(_ mqtt5: CocoaMQTT5, didSubscribeTopics success: NSDictionary, failed: [String], subAckData: MqttDecodeSubAck?) {}

    func mqtt5(_ mqtt5: CocoaMQTT5, didUnsubscribeTopics topics: [String], UnsubAckData: MqttDecodeUnsubAck?) {}

    func mqtt5DidPing(_ mqtt5: CocoaMQTT5) {}

    func mqtt5DidReceivePong(_ mqtt5: CocoaMQTT5) {}

    func mqtt5DidDisconnect(_ mqtt5: CocoaMQTT5, withError err: (any Error)?) {
        connectedSubject.send(false)
    }
}
```

- [ ] **Step 2: Verify build succeeds**

Run: Cmd+B
Expected: BUILD SUCCEEDED (CocoaMQTT API may need minor adjustments based on exact version)

- [ ] **Step 3: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/Core/MQTT/MQTTService.swift
git commit -m "feat(mobile): add real CocoaMQTT5 service implementation with TLS and auto-reconnect"
```

---

### Task 14: Localization (en + zh-CN)

**Files:**
- Create: `TeamClawMobile/TeamClawMobile/Resources/Localizable.xcstrings`

- [ ] **Step 1: Create Localizable.xcstrings**

In Xcode: File → New → File → String Catalog. Add localizations for `en` and `zh-Hans`.

Key strings to localize:

| Key | en | zh-Hans |
|-----|----|---------|
| `session_title` | Session | 会话 |
| `desktop_online` | Desktop Online | 桌面端在线 |
| `desktop_offline` | Desktop Offline | 桌面端离线 |
| `search` | Search | 搜索 |
| `new_session` | New Session | 新建会话 |
| `automation` | Automation | 自动化 |
| `skills` | Skills | 技能 |
| `settings` | Settings | 设置 |
| `pair_device` | Pair Device | 配对设备 |
| `enter_code` | Enter the 6-digit pairing code | 输入6位配对码 |
| `unpair` | Unpair | 解除配对 |
| `send` | Send | 发送 |
| `input_placeholder` | Type a message... | 输入消息... |
| `team_members` | Team Members | 团队成员 |
| `my_skills` | My Skills | 我的技能 |
| `team_skills` | Team Skills | 团队技能 |
| `new_collab_session` | New Collaborative Session | 新建协作会话 |

- [ ] **Step 2: Replace hardcoded strings in views with localized keys**

Update all views to use `String(localized:)` or `LocalizedStringKey` for user-facing text.

Example: In `DesktopStatusBadge.swift`:
```swift
Text(isOnline ? String(localized: "desktop_online") : String(localized: "desktop_offline"))
```

- [ ] **Step 3: Verify build succeeds**

Run: Cmd+B
Expected: BUILD SUCCEEDED

- [ ] **Step 4: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/Resources/ TeamClawMobile/TeamClawMobile/
git commit -m "feat(mobile): add en/zh-CN localization for all user-facing strings"
```

---

### Task 15: Final Integration Test & Polish

**Files:**
- Create: `TeamClawMobileUITests/NavigationUITests.swift`

- [ ] **Step 1: Write basic UI navigation test**

```swift
// TeamClawMobileUITests/NavigationUITests.swift
import XCTest

final class NavigationUITests: XCTestCase {
    let app = XCUIApplication()

    override func setUp() {
        continueAfterFailure = false
        app.launch()
    }

    func testPairingViewShownOnFirstLaunch() {
        // On first launch with no pairing, should show pairing view
        XCTAssertTrue(app.staticTexts["连接桌面端"].exists || app.staticTexts["Pair Device"].exists)
    }

    func testPairingCodeInput() {
        let textField = app.textFields.firstMatch
        XCTAssertTrue(textField.waitForExistence(timeout: 2))
        textField.tap()
        textField.typeText("123456")
        // Pair button should be enabled
        let pairButton = app.buttons["配对"].firstMatch
        XCTAssertTrue(pairButton.isEnabled)
    }
}
```

- [ ] **Step 2: Run UI tests**

Run: `xcodebuild test -scheme TeamClawMobile -destination 'platform=iOS Simulator,name=iPhone 16' -only-testing:TeamClawMobileUITests`
Expected: Tests PASS

- [ ] **Step 3: Run all unit tests**

Run: `xcodebuild test -scheme TeamClawMobile -destination 'platform=iOS Simulator,name=iPhone 16'`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add TeamClawMobileUITests/
git commit -m "test(mobile): add UI navigation tests for pairing flow"
```

- [ ] **Step 5: Final commit — update spec status**

Update `docs/superpowers/specs/2026-04-02-ios-mobile-client-design.md` line 5:
Change `**Status:** Draft` to `**Status:** Implementation Plan Complete`

```bash
git add docs/superpowers/specs/2026-04-02-ios-mobile-client-design.md
git commit -m "docs(mobile): mark design spec as implementation plan complete"
```

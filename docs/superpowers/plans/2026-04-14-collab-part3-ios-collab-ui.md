# Collaborative Session Part 3: iOS Collab UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable iOS users to create collaborative sessions, invite team members, chat together, @Agent for AI responses, and manage session lifecycle (leave/end).

**Architecture:** Extend existing chat UI to handle multi-person messages with sender identity. Create a new Collab ViewModel that manages MQTT session topic subscription, CollabControl messages, and sender-aware message rendering. Reuse existing MessageBubbleView's `.collaborator` role for other participants' messages.

**Tech Stack:** Swift, SwiftUI, SwiftData, Combine, CocoaMQTT5, SwiftProtobuf

**Spec:** `docs/superpowers/specs/2026-04-14-collab-session-v1-design.md` (Sections 4-6: Lifecycle, Chat, iOS Changes)

**Dependency:** Part 1 (proto + desktop relay) for Agent functionality. Part 2 (lightweight login) for non-paired users to participate.

---

## File Structure

### New files
- `TeamClawMobile/TeamClawMobile/Features/Collab/CollabChatViewModel.swift` — ViewModel for collab chat (MQTT session topic, message routing, @Agent)
- `TeamClawMobile/TeamClawMobile/Features/Collab/CollabChatView.swift` — Chat view for collab sessions (wraps existing components)
- `TeamClawMobile/TeamClawMobile/Features/Collab/CreateCollabSheet.swift` — Create collab session + member selection

### Modified files
- `TeamClawMobile/TeamClawMobile/App/ContentView.swift` — Handle CollabControl on inbox topic
- `TeamClawMobile/TeamClawMobile/Features/SessionList/SessionListView.swift` — Show collab sessions, navigate to CollabChatView
- `TeamClawMobile/TeamClawMobile/Models/Session.swift` — Add `ownerNodeId`, `agentHostDevice` fields
- `TeamClawMobile/TeamClawMobile/Models/ChatMessage.swift` — No changes needed (already has senderName, .collaborator role)

---

## Task 1: Extend Session Model

**Files:**
- Modify: `TeamClawMobile/TeamClawMobile/Models/Session.swift`

- [ ] **Step 1: Add collab-specific fields to Session**

Add new fields to the Session model:

```swift
var ownerNodeId: String?          // Creator's node_id
var agentHostDevice: String?      // Desktop device_id hosting the Agent
```

Add to `init` with defaults:

```swift
init(
    // ... existing params ...
    ownerNodeId: String? = nil,
    agentHostDevice: String? = nil
) {
    // ... existing assignments ...
    self.ownerNodeId = ownerNodeId
    self.agentHostDevice = agentHostDevice
}
```

- [ ] **Step 2: Verify build**

- [ ] **Step 3: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/Models/Session.swift
git commit -m "feat(ios): add ownerNodeId and agentHostDevice to Session model"
```

---

## Task 2: CreateCollabSheet

**Files:**
- Create: `TeamClawMobile/TeamClawMobile/Features/Collab/CreateCollabSheet.swift`

- [ ] **Step 1: Create the collab session creation sheet**

```swift
import SwiftUI
import SwiftData

struct CreateCollabSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    
    let mqttService: MQTTServiceProtocol
    let onCreated: (Session) -> Void
    
    @State private var selectedMemberIDs: Set<String> = []
    @State private var showMemberPicker = false
    @Query(sort: \TeamMember.name) private var allMembers: [TeamMember]
    
    private var selectedMembers: [TeamMember] {
        allMembers.filter { selectedMemberIDs.contains($0.id) && !$0.isAIAlly }
    }
    
    var body: some View {
        NavigationStack {
            Form {
                Section("选择协作成员") {
                    ForEach(selectedMembers, id: \.id) { member in
                        HStack {
                            Text(member.name)
                            Spacer()
                            Button { selectedMemberIDs.remove(member.id) } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    
                    Button {
                        showMemberPicker = true
                    } label: {
                        Label("添加成员", systemImage: "plus.circle")
                    }
                }
                
                Section {
                    Button("创建协作会话") {
                        createCollabSession()
                    }
                    .disabled(selectedMembers.isEmpty)
                }
            }
            .navigationTitle("新建协作")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
            }
            .sheet(isPresented: $showMemberPicker) {
                UnifiedMemberSheet(
                    mode: .select(
                        preSelected: selectedMemberIDs,
                        onConfirm: { ids in selectedMemberIDs = ids }
                    ),
                    mqttService: mqttService
                )
            }
        }
    }
    
    private func createCollabSession() {
        guard let creds = PairingManager.currentCredentials else { return }
        
        let sessionID = UUID().uuidString
        let memberNames = selectedMembers.map(\.name).joined(separator: "、")
        let title = "协作: \(memberNames)"
        
        // Create local Session
        let session = Session(
            id: sessionID,
            title: title.count > 50 ? String(title.prefix(50)) + "…" : title,
            agentName: "Agent",
            lastMessageContent: "",
            lastMessageTime: Date(),
            isCollaborative: true,
            collaboratorIDs: selectedMembers.map(\.id),
            ownerNodeId: creds.deviceID,
            agentHostDevice: creds.desktopDeviceID
        )
        modelContext.insert(session)
        try? modelContext.save()
        
        // Build CollabControl CREATE message
        var ctrl = Teamclaw_CollabControl()
        ctrl.type = .collabCreate
        ctrl.senderID = creds.deviceID
        ctrl.senderName = PairingManager().username
        ctrl.sessionID = sessionID
        ctrl.agentHostDevice = creds.desktopDeviceID
        
        // Add self + selected members
        var selfMember = Teamclaw_CollabMember()
        selfMember.nodeID = creds.deviceID
        selfMember.name = PairingManager().username
        ctrl.members.append(selfMember)
        
        for member in selectedMembers {
            var m = Teamclaw_CollabMember()
            m.nodeID = member.id
            m.name = member.name
            ctrl.members.append(m)
        }
        
        let envelope = ProtoMQTTCoder.makeEnvelope(.collabControl(ctrl))
        
        // Publish to each member's inbox
        for member in selectedMembers {
            let topic = "teamclaw/\(creds.teamID)/user/\(member.id)/inbox"
            mqttService.publish(topic: topic, message: envelope, qos: 1)
        }
        
        // Publish to own Desktop (Agent host)
        let desktopTopic = "teamclaw/\(creds.teamID)/\(creds.desktopDeviceID)/chat/req"
        mqttService.publish(topic: desktopTopic, message: envelope, qos: 1)
        
        // Subscribe to session topic
        mqttService.subscribe(
            topic: "teamclaw/\(creds.teamID)/session/\(sessionID)",
            qos: 1
        )
        
        onCreated(session)
        dismiss()
    }
}
```

- [ ] **Step 2: Verify build**

- [ ] **Step 3: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/Features/Collab/
git commit -m "feat(ios): add CreateCollabSheet for collaborative session creation"
```

---

## Task 3: CollabChatViewModel

**Files:**
- Create: `TeamClawMobile/TeamClawMobile/Features/Collab/CollabChatViewModel.swift`

- [ ] **Step 1: Create the ViewModel**

This is the core of collab chat. It handles:
- Subscribing to session topic
- Receiving messages from other participants + Agent
- Sending messages (with sender identity)
- @Agent detection
- Requesting history from Desktop

```swift
import SwiftUI
import SwiftData
import Combine

@MainActor
final class CollabChatViewModel: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var inputText = ""
    @Published var isLoadingHistory = false
    
    let session: Session
    private let mqttService: MQTTServiceProtocol
    private var modelContext: ModelContext?
    private var cancellables = Set<AnyCancellable>()
    private let myNodeID: String
    private let myUsername: String
    private let teamID: String
    
    init(session: Session, mqttService: MQTTServiceProtocol) {
        self.session = session
        self.mqttService = mqttService
        
        let creds = PairingManager.currentCredentials
        self.myNodeID = creds?.deviceID ?? ""
        self.teamID = creds?.teamID ?? ""
        self.myUsername = UserDefaults.standard.string(forKey: "teamclaw_username") ?? "Unknown"
        
        subscribeToMQTT()
    }
    
    func setModelContext(_ context: ModelContext) {
        self.modelContext = context
        loadLocalMessages()
    }
    
    // MARK: - Send Message
    
    func sendMessage() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        
        // Save locally
        let message = ChatMessage(
            id: UUID().uuidString,
            sessionID: session.id,
            role: .user,
            content: text,
            timestamp: Date(),
            senderName: myUsername
        )
        modelContext?.insert(message)
        try? modelContext?.save()
        messages.append(message)
        inputText = ""
        
        // Publish to session topic
        var req = Teamclaw_ChatRequest()
        req.sessionID = session.id
        req.content = text
        req.senderID = myNodeID
        req.senderName = myUsername
        req.senderType = "human"
        
        let envelope = ProtoMQTTCoder.makeEnvelope(.chatRequest(req))
        let topic = "teamclaw/\(teamID)/session/\(session.id)"
        mqttService.publish(topic: topic, message: envelope, qos: 1)
        
        // Update session last message
        session.lastMessageContent = text
        session.lastMessageTime = Date()
        try? modelContext?.save()
    }
    
    // MARK: - Request History
    
    func requestHistory() {
        isLoadingHistory = true
        var req = Teamclaw_MessageSyncRequest()
        req.sessionID = session.id
        let envelope = ProtoMQTTCoder.makeEnvelope(.messageSyncRequest(req))
        let topic = "teamclaw/\(teamID)/session/\(session.id)"
        mqttService.publish(topic: topic, message: envelope, qos: 1)
    }
    
    // MARK: - Leave Session
    
    func leaveSession() {
        var ctrl = Teamclaw_CollabControl()
        ctrl.type = .collabLeave
        ctrl.senderID = myNodeID
        ctrl.senderName = myUsername
        ctrl.sessionID = session.id
        
        let envelope = ProtoMQTTCoder.makeEnvelope(.collabControl(ctrl))
        let topic = "teamclaw/\(teamID)/session/\(session.id)"
        mqttService.publish(topic: topic, message: envelope, qos: 1)
        
        // Unsubscribe
        mqttService.unsubscribe(topic: topic)
        
        // Mark session locally
        session.isArchived = true
        try? modelContext?.save()
    }
    
    // MARK: - End Session (creator only)
    
    func endSession() {
        var ctrl = Teamclaw_CollabControl()
        ctrl.type = .collabEnd
        ctrl.senderID = myNodeID
        ctrl.senderName = myUsername
        ctrl.sessionID = session.id
        
        let envelope = ProtoMQTTCoder.makeEnvelope(.collabControl(ctrl))
        let topic = "teamclaw/\(teamID)/session/\(session.id)"
        mqttService.publish(topic: topic, message: envelope, qos: 1)
        
        // Unsubscribe
        mqttService.unsubscribe(topic: topic)
        
        session.isArchived = true
        try? modelContext?.save()
    }
    
    var isOwner: Bool {
        session.ownerNodeId == myNodeID
    }
    
    // MARK: - Private
    
    private func subscribeToMQTT() {
        // Subscribe to session topic
        let sessionTopic = "teamclaw/\(teamID)/session/\(session.id)"
        mqttService.subscribe(topic: sessionTopic, qos: 1)
        
        mqttService.receivedMessage
            .receive(on: DispatchQueue.main)
            .sink { [weak self] msg in
                self?.handleMQTTMessage(msg)
            }
            .store(in: &cancellables)
    }
    
    private func handleMQTTMessage(_ msg: Teamclaw_MqttMessage) {
        switch msg.payload {
        case .chatRequest(let req) where req.sessionID == session.id:
            handleIncomingChatRequest(req)
        case .messageSyncResponse(let resp) where resp.sessionID == session.id:
            handleMessageSync(resp)
        case .collabControl(let ctrl) where ctrl.sessionID == session.id:
            handleCollabControl(ctrl)
        default:
            break
        }
    }
    
    private func handleIncomingChatRequest(_ req: Teamclaw_ChatRequest) {
        // Ignore own messages (already added locally when sent)
        if req.senderID == myNodeID && req.senderType != "agent" { return }
        
        let role: MessageRole
        if req.senderType == "agent" {
            role = .assistant
        } else {
            role = .collaborator
        }
        
        let message = ChatMessage(
            id: UUID().uuidString,
            sessionID: session.id,
            role: role,
            content: req.content,
            timestamp: Date(),
            senderName: req.senderName.isEmpty ? nil : req.senderName
        )
        
        modelContext?.insert(message)
        try? modelContext?.save()
        messages.append(message)
        
        // Update session
        session.lastMessageContent = req.content
        session.lastMessageTime = Date()
        try? modelContext?.save()
    }
    
    private func handleMessageSync(_ resp: Teamclaw_MessageSyncResponse) {
        guard let modelContext else { return }
        isLoadingHistory = false
        
        let existingIDs = Set(messages.map(\.id))
        var newMessages: [ChatMessage] = []
        
        for data in resp.messages {
            guard !existingIDs.contains(data.id) else { continue }
            
            let role: MessageRole
            if data.role == "assistant" {
                role = .assistant
            } else if data.hasSenderID && data.senderID != myNodeID {
                role = .collaborator
            } else {
                role = .user
            }
            
            let message = ChatMessage(
                id: data.id,
                sessionID: session.id,
                role: role,
                content: data.content,
                timestamp: Date(timeIntervalSince1970: data.timestamp),
                senderName: data.hasSenderName ? data.senderName : nil
            )
            modelContext.insert(message)
            newMessages.append(message)
        }
        
        if !newMessages.isEmpty {
            try? modelContext.save()
            let descriptor = FetchDescriptor<ChatMessage>(
                predicate: #Predicate { $0.sessionID == session.id },
                sortBy: [SortDescriptor(\.timestamp)]
            )
            messages = (try? modelContext.fetch(descriptor)) ?? messages
        }
    }
    
    private func handleCollabControl(_ ctrl: Teamclaw_CollabControl) {
        switch ctrl.type {
        case .collabEnd:
            // Session ended by owner — add system message
            let sysMsg = ChatMessage(
                id: UUID().uuidString,
                sessionID: session.id,
                role: .assistant,
                content: "协作已结束",
                timestamp: Date()
            )
            modelContext?.insert(sysMsg)
            try? modelContext?.save()
            messages.append(sysMsg)
            
            session.isArchived = true
            try? modelContext?.save()
            
        case .collabLeave:
            let name = ctrl.senderName.isEmpty ? "某人" : ctrl.senderName
            let sysMsg = ChatMessage(
                id: UUID().uuidString,
                sessionID: session.id,
                role: .assistant,
                content: "\(name) 离开了协作",
                timestamp: Date()
            )
            modelContext?.insert(sysMsg)
            try? modelContext?.save()
            messages.append(sysMsg)
            
        default:
            break
        }
    }
    
    private func loadLocalMessages() {
        guard let modelContext else { return }
        let sid = session.id
        let descriptor = FetchDescriptor<ChatMessage>(
            predicate: #Predicate { $0.sessionID == sid },
            sortBy: [SortDescriptor(\.timestamp)]
        )
        messages = (try? modelContext.fetch(descriptor)) ?? []
    }
}
```

- [ ] **Step 2: Add unsubscribe to MQTTServiceProtocol**

Check if `MQTTServiceProtocol` has an `unsubscribe` method. If not, add it:

In `MQTTServiceProtocol.swift`:
```swift
func unsubscribe(topic: String)
```

In `MQTTService.swift`:
```swift
func unsubscribe(topic: String) {
    mqtt?.unsubscribe(topic)
}
```

- [ ] **Step 3: Verify build**

- [ ] **Step 4: Commit**

```bash
git add TeamClawMobile/
git commit -m "feat(ios): add CollabChatViewModel with MQTT session messaging"
```

---

## Task 4: CollabChatView

**Files:**
- Create: `TeamClawMobile/TeamClawMobile/Features/Collab/CollabChatView.swift`

- [ ] **Step 1: Create the chat view**

Reuses existing `MessageBubbleView` (which already handles `.collaborator` role with green bubbles):

```swift
import SwiftUI
import SwiftData

struct CollabChatView: View {
    @StateObject private var viewModel: CollabChatViewModel
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    @FocusState private var isInputFocused: Bool
    
    init(session: Session, mqttService: MQTTServiceProtocol) {
        _viewModel = StateObject(wrappedValue: CollabChatViewModel(
            session: session,
            mqttService: mqttService
        ))
    }
    
    var body: some View {
        VStack(spacing: 0) {
            // Messages
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(viewModel.messages, id: \.id) { message in
                            MessageBubbleView(message: message)
                                .id(message.id)
                        }
                    }
                    .padding(.vertical, 8)
                }
                .onChange(of: viewModel.messages.count) { _, _ in
                    if let lastID = viewModel.messages.last?.id {
                        withAnimation { proxy.scrollTo(lastID, anchor: .bottom) }
                    }
                }
            }
            
            Divider()
            
            // Input
            HStack(spacing: 8) {
                TextField("消息... (输入 @Agent 触发AI)", text: $viewModel.inputText, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...5)
                    .focused($isInputFocused)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(.systemGray6))
                    .clipShape(RoundedRectangle(cornerRadius: 20))
                
                Button {
                    viewModel.sendMessage()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                }
                .disabled(viewModel.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .navigationTitle(viewModel.session.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Section {
                        Text("\(viewModel.session.collaboratorIDs.count + 1) 位成员")
                    }
                    
                    if viewModel.isOwner {
                        Button(role: .destructive) {
                            viewModel.endSession()
                            dismiss()
                        } label: {
                            Label("结束协作", systemImage: "xmark.circle")
                        }
                    } else {
                        Button(role: .destructive) {
                            viewModel.leaveSession()
                            dismiss()
                        } label: {
                            Label("离开协作", systemImage: "arrow.left.circle")
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
        .onAppear {
            viewModel.setModelContext(modelContext)
            if viewModel.messages.isEmpty {
                viewModel.requestHistory()
            }
        }
    }
}
```

- [ ] **Step 2: Verify build**

- [ ] **Step 3: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/Features/Collab/CollabChatView.swift
git commit -m "feat(ios): add CollabChatView with multi-person message display"
```

---

## Task 5: Handle Incoming CollabControl in ContentView

**Files:**
- Modify: `TeamClawMobile/TeamClawMobile/App/ContentView.swift`

- [ ] **Step 1: Subscribe to inbox and handle CollabControl CREATE**

In `subscribeToMQTT` (or equivalent), add a listener for CollabControl messages on the user's inbox topic. When a CREATE is received, auto-create a local Session and subscribe to the session topic.

Add to ContentView (or a coordinator object):

```swift
private func subscribeToCollabInbox() {
    connectionMonitor.mqttService.receivedMessage
        .compactMap { msg -> Teamclaw_CollabControl? in
            if case .collabControl(let ctrl) = msg.payload,
               ctrl.type == .collabCreate {
                return ctrl
            }
            return nil
        }
        .receive(on: DispatchQueue.main)
        .sink { [self] ctrl in
            handleCollabCreate(ctrl)
        }
        .store(in: &cancellables)
}

private func handleCollabCreate(_ ctrl: Teamclaw_CollabControl) {
    let sessionID = ctrl.sessionID
    guard !sessionID.isEmpty else { return }
    
    // Check if session already exists locally
    let descriptor = FetchDescriptor<Session>(
        predicate: #Predicate { $0.id == sessionID }
    )
    if let existing = try? modelContext.fetch(descriptor), !existing.isEmpty { return }
    
    // Create local session
    let memberNames = ctrl.members.map(\.name).joined(separator: "、")
    let title = "协作: \(memberNames)"
    let session = Session(
        id: sessionID,
        title: title.count > 50 ? String(title.prefix(50)) + "…" : title,
        agentName: "Agent",
        lastMessageContent: "\(ctrl.senderName) 创建了协作会话",
        lastMessageTime: Date(),
        isCollaborative: true,
        collaboratorIDs: ctrl.members.map(\.nodeID),
        ownerNodeId: ctrl.senderID,
        agentHostDevice: ctrl.agentHostDevice
    )
    modelContext.insert(session)
    try? modelContext.save()
    
    // Subscribe to session topic
    guard let creds = PairingManager.currentCredentials else { return }
    connectionMonitor.mqttService.subscribe(
        topic: "teamclaw/\(creds.teamID)/session/\(sessionID)",
        qos: 1
    )
}
```

Call `subscribeToCollabInbox()` after MQTT connects (alongside existing `subscribeTopics`).

- [ ] **Step 2: Re-subscribe to active collab sessions on app startup**

In `requestInitialData` or `subscribeTopics`, re-subscribe to all active collab sessions:

```swift
// Re-subscribe to active collab sessions
let collabDescriptor = FetchDescriptor<Session>(
    predicate: #Predicate { $0.isCollaborative && !$0.isArchived }
)
if let collabSessions = try? modelContext.fetch(collabDescriptor) {
    for session in collabSessions {
        let topic = "teamclaw/\(creds.teamID)/session/\(session.id)"
        mqtt.subscribe(topic: topic, qos: 1)
    }
}
```

- [ ] **Step 3: Verify build**

- [ ] **Step 4: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/App/ContentView.swift
git commit -m "feat(ios): handle CollabControl CREATE on inbox and re-subscribe on startup"
```

---

## Task 6: Integrate Collab into Session List

**Files:**
- Modify: `TeamClawMobile/TeamClawMobile/Features/SessionList/SessionListView.swift`

- [ ] **Step 1: Add "New Collab" button**

Add a button in the toolbar or action sheet for creating collaborative sessions. Only show for paired users:

```swift
// In toolbar or alongside existing "New Session" button
if !isLightweightUser {
    Button {
        showCreateCollab = true
    } label: {
        Label("新建协作", systemImage: "person.2.circle")
    }
}
```

Add state:
```swift
@State private var showCreateCollab = false
```

Add sheet:
```swift
.sheet(isPresented: $showCreateCollab) {
    CreateCollabSheet(mqttService: mqttService) { session in
        // Navigate to the new collab chat
    }
}
```

- [ ] **Step 2: Navigate to CollabChatView for collaborative sessions**

When a collaborative session is tapped, navigate to `CollabChatView` instead of `ChatDetailView`:

```swift
ForEach(viewModel.filteredSessions, id: \.id) { session in
    NavigationLink {
        if session.isCollaborative {
            CollabChatView(session: session, mqttService: mqttService)
        } else {
            ChatDetailView(sessionID: session.id, mqttService: mqttService)
        }
    } label: {
        SessionRow(session: session)
    }
}
```

- [ ] **Step 3: Add visual indicator for collab sessions in the row**

In the session row, show a group icon for collaborative sessions:

```swift
// Inside SessionRow or wherever session rows are rendered
if session.isCollaborative {
    Image(systemName: "person.2.fill")
        .font(.caption)
        .foregroundStyle(.green)
}
```

- [ ] **Step 4: For lightweight users, hide personal session creation**

Accept `isLightweightUser` parameter and conditionally hide the "New Session" (single-user) button:

```swift
let isLightweightUser: Bool

// In toolbar
if !isLightweightUser {
    Button { /* new single-user session */ } label: {
        Label("新建会话", systemImage: "plus")
    }
}
```

- [ ] **Step 5: Verify build**

- [ ] **Step 6: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/Features/
git commit -m "feat(ios): integrate collab sessions into session list with navigation"
```

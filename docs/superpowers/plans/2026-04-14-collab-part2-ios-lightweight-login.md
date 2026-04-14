# Collaborative Session Part 2: iOS Lightweight Login

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow team members without a paired Desktop to join TeamClaw on iOS via a one-time invite link, set a username, and participate in collaborative sessions.

**Architecture:** Add a `teamclaw://join` deep link handler. Extend PairingManager with a lightweight user state (team credentials without Desktop pairing). Generate invite tokens locally and store in team manifest. Lightweight users connect to MQTT with team credentials and see only collaborative sessions.

**Tech Stack:** Swift, SwiftUI, CocoaMQTT5, SwiftData, UserDefaults

**Spec:** `docs/superpowers/specs/2026-04-14-collab-session-v1-design.md` (Section 1: Invitation Link & Lightweight Login)

**Dependency:** Part 1 (proto + desktop relay) must be complete for end-to-end testing.

---

## File Structure

### New files
- `TeamClawMobile/TeamClawMobile/Features/Join/JoinTeamView.swift` — Deep link landing: validate token + set username
- `TeamClawMobile/TeamClawMobile/Features/Settings/InviteView.swift` — Generate + share invite links
- `TeamClawMobile/TeamClawMobile/Features/Settings/UsernameSettingView.swift` — Edit username (reusable)

### Modified files
- `TeamClawMobile/TeamClawMobile/Info.plist` — Register `teamclaw://` URL scheme
- `TeamClawMobile/TeamClawMobile/App/TeamClawMobileApp.swift` — Handle `.onOpenURL`
- `TeamClawMobile/TeamClawMobile/App/ContentView.swift` — Route lightweight users to collab-only view
- `TeamClawMobile/TeamClawMobile/Core/PairingManager.swift` — Add lightweight user state + username storage
- `TeamClawMobile/TeamClawMobile/Features/Settings/SettingsView.swift` — Add username + invite sections

---

## Task 1: Register URL Scheme + Deep Link Handler

**Files:**
- Modify: `TeamClawMobile/TeamClawMobile/Info.plist`
- Modify: `TeamClawMobile/TeamClawMobile/App/TeamClawMobileApp.swift`

- [ ] **Step 1: Add URL scheme to Info.plist**

Add inside the top-level `<dict>`:

```xml
<key>CFBundleURLTypes</key>
<array>
    <dict>
        <key>CFBundleURLSchemes</key>
        <array>
            <string>teamclaw</string>
        </array>
        <key>CFBundleURLName</key>
        <string>com.teamclaw.mobile</string>
    </dict>
</array>
```

- [ ] **Step 2: Add onOpenURL handler in TeamClawMobileApp**

In `TeamClawMobileApp.swift`, add a `@State` for pending join URL and pass it to ContentView:

```swift
@main
struct TeamClawMobileApp: App {
    @StateObject private var pairingManager = PairingManager()
    @State private var pendingJoinURL: URL?
    
    private static let appContainer: ModelContainer = { /* existing */ }()
    
    var body: some Scene {
        WindowGroup {
            ContentView(pairingManager: pairingManager, pendingJoinURL: $pendingJoinURL)
                .onOpenURL { url in
                    if url.scheme == "teamclaw" && url.host == "join" {
                        pendingJoinURL = url
                    }
                }
        }
        .modelContainer(Self.appContainer)
    }
}
```

- [ ] **Step 3: Verify Xcode build**

```bash
cd TeamClawMobile && xcodebuild build -scheme TeamClawMobile -destination 'platform=iOS Simulator,name=iPhone 16' 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add TeamClawMobile/
git commit -m "feat(ios): register teamclaw:// URL scheme and deep link handler"
```

---

## Task 2: Extend PairingManager with Lightweight User State

**Files:**
- Modify: `TeamClawMobile/TeamClawMobile/Core/PairingManager.swift`

- [ ] **Step 1: Add new UserDefaults keys and published properties**

Add to the `Keys` enum:

```swift
static let isLightweightUser = "teamclaw_is_lightweight_user"
static let username          = "teamclaw_username"
static let userNodeID        = "teamclaw_user_node_id"
```

Add published properties:

```swift
@Published var isLightweightUser = false
@Published var username: String = ""
```

In `init()`, load these:

```swift
isLightweightUser = UserDefaults.standard.bool(forKey: Keys.isLightweightUser)
username = UserDefaults.standard.string(forKey: Keys.username) ?? ""
```

- [ ] **Step 2: Add computed property for auth state**

```swift
/// User is either paired or lightweight — either way they can use the app
var isAuthenticated: Bool {
    isPaired || isLightweightUser
}
```

- [ ] **Step 3: Add lightweight login method**

```swift
func loginAsLightweightUser(
    teamID: String,
    mqttHost: String,
    mqttPort: UInt16,
    mqttUsername: String,
    mqttPassword: String,
    username: String
) {
    let nodeID = UUID().uuidString
    let ud = UserDefaults.standard
    ud.set(true, forKey: Keys.isLightweightUser)
    ud.set(username, forKey: Keys.username)
    ud.set(nodeID, forKey: Keys.userNodeID)
    ud.set(mqttHost, forKey: Keys.mqttHost)
    ud.set(Int(mqttPort), forKey: Keys.mqttPort)
    ud.set(mqttUsername, forKey: Keys.mqttUsername)
    ud.set(mqttPassword, forKey: Keys.mqttPassword)
    ud.set(teamID, forKey: Keys.teamID)
    ud.set(nodeID, forKey: Keys.deviceID)
    
    self.isLightweightUser = true
    self.username = username
}
```

- [ ] **Step 4: Add username update method**

```swift
func updateUsername(_ newName: String) {
    UserDefaults.standard.set(newName, forKey: Keys.username)
    self.username = newName
}
```

- [ ] **Step 5: Extend currentCredentials to work for lightweight users**

Modify `static var currentCredentials` to also check `isLightweightUser`:

```swift
static var currentCredentials: PairingCredentials? {
    let ud = UserDefaults.standard
    let isPaired = ud.bool(forKey: Keys.isPaired)
    let isLight = ud.bool(forKey: Keys.isLightweightUser)
    guard isPaired || isLight,
          let host = ud.string(forKey: Keys.mqttHost),
          // ... rest of existing checks ...
    else { return nil }
    
    let desktopID = ud.string(forKey: Keys.desktopDeviceID) ?? ""
    let deviceName = ud.string(forKey: Keys.pairedDeviceName) ?? ud.string(forKey: Keys.username) ?? "Unknown"
    
    return PairingCredentials(
        mqttHost: host,
        mqttPort: port == 0 ? 8883 : port,
        mqttUsername: username,
        mqttPassword: password,
        teamID: teamID,
        deviceID: deviceID,
        desktopDeviceID: desktopID,
        desktopDeviceName: deviceName
    )
}
```

- [ ] **Step 6: Add logout method for lightweight users**

```swift
func logoutLightweightUser() {
    let ud = UserDefaults.standard
    ud.removeObject(forKey: Keys.isLightweightUser)
    ud.removeObject(forKey: Keys.username)
    ud.removeObject(forKey: Keys.userNodeID)
    ud.removeObject(forKey: Keys.mqttHost)
    ud.removeObject(forKey: Keys.mqttPort)
    ud.removeObject(forKey: Keys.mqttUsername)
    ud.removeObject(forKey: Keys.mqttPassword)
    ud.removeObject(forKey: Keys.teamID)
    ud.removeObject(forKey: Keys.deviceID)
    
    self.isLightweightUser = false
    self.username = ""
}
```

- [ ] **Step 7: Verify build**

- [ ] **Step 8: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/Core/PairingManager.swift
git commit -m "feat(ios): extend PairingManager with lightweight user state"
```

---

## Task 3: Update ContentView Routing

**Files:**
- Modify: `TeamClawMobile/TeamClawMobile/App/ContentView.swift`

- [ ] **Step 1: Accept pendingJoinURL binding**

Add parameter to ContentView:

```swift
@Binding var pendingJoinURL: URL?
```

- [ ] **Step 2: Update routing logic**

Replace the existing `if pairingManager.isPaired` check:

```swift
Group {
    if pendingJoinURL != nil {
        JoinTeamView(
            url: pendingJoinURL!,
            pairingManager: pairingManager,
            onComplete: { pendingJoinURL = nil }
        )
    } else if pairingManager.isAuthenticated {
        SessionListView(
            mqttService: connectionMonitor.mqttService,
            pairingManager: pairingManager,
            isLightweightUser: pairingManager.isLightweightUser
        )
    } else {
        PairingView(pairingManager: pairingManager)
    }
}
```

- [ ] **Step 3: Update connectIfPaired to also connect lightweight users**

Rename to `connectIfAuthenticated` and check `pairingManager.isAuthenticated` instead of `isPaired`.

- [ ] **Step 4: Update subscribeTopics for lightweight users**

Lightweight users don't subscribe to device-specific topics (no Desktop). They subscribe to:
- `teamclaw/{team_id}/user/{node_id}/inbox` — for collab invitations

```swift
private func subscribeTopics(creds: PairingCredentials) {
    let mqtt = connectionMonitor.mqttService
    
    if pairingManager.isPaired {
        // Existing device-based subscriptions
        mqtt.subscribe(topic: "teamclaw/\(creds.teamID)/\(creds.desktopDeviceID)/status", qos: 1)
        mqtt.subscribe(topic: "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/res", qos: 1)
        // ... other existing subscriptions
    }
    
    // All users subscribe to personal inbox for collab invitations
    mqtt.subscribe(topic: "teamclaw/\(creds.teamID)/user/\(creds.deviceID)/inbox", qos: 1)
}
```

- [ ] **Step 5: Verify build**

- [ ] **Step 6: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/App/
git commit -m "feat(ios): route lightweight users and handle join deep link"
```

---

## Task 4: JoinTeamView (Token Validation + Username)

**Files:**
- Create: `TeamClawMobile/TeamClawMobile/Features/Join/JoinTeamView.swift`

- [ ] **Step 1: Create JoinTeamView**

```swift
import SwiftUI

struct JoinTeamView: View {
    let url: URL
    @ObservedObject var pairingManager: PairingManager
    let onComplete: () -> Void
    
    @State private var username = ""
    @State private var isValidating = false
    @State private var error: String?
    @State private var tokenValidated = false
    @State private var teamCredentials: TeamJoinCredentials?
    
    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                if isValidating {
                    ProgressView("验证邀请链接...")
                } else if let error {
                    errorView(error)
                } else if tokenValidated {
                    usernameInputView
                } else {
                    ProgressView()
                }
            }
            .padding()
            .navigationTitle("加入团队")
            .task { await validateToken() }
        }
    }
    
    private var usernameInputView: some View {
        VStack(spacing: 20) {
            Text("设置你的用户名")
                .font(.headline)
            
            TextField("用户名", text: $username)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
            
            Button("加入") {
                guard let creds = teamCredentials, !username.isEmpty else { return }
                pairingManager.loginAsLightweightUser(
                    teamID: creds.teamID,
                    mqttHost: creds.mqttHost,
                    mqttPort: creds.mqttPort,
                    mqttUsername: creds.mqttUsername,
                    mqttPassword: creds.mqttPassword,
                    username: username.trimmingCharacters(in: .whitespacesAndNewlines)
                )
                onComplete()
            }
            .buttonStyle(.borderedProminent)
            .disabled(username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }
    
    private func errorView(_ message: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle")
                .font(.largeTitle)
                .foregroundStyle(.orange)
            Text(message)
                .multilineTextAlignment(.center)
            Button("返回") { onComplete() }
        }
    }
    
    private func validateToken() async {
        isValidating = true
        defer { isValidating = false }
        
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let ticket = components.queryItems?.first(where: { $0.name == "ticket" })?.value,
              let teamID = components.queryItems?.first(where: { $0.name == "team" })?.value
        else {
            error = "无效的邀请链接"
            return
        }
        
        // For v1: ticket contains base64-encoded JSON with MQTT credentials + expiry
        // Format: base64({ mqttHost, mqttPort, mqttUsername, mqttPassword, teamID, expiresAt })
        guard let data = Data(base64Encoded: ticket),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let mqttHost = json["mqttHost"] as? String,
              let mqttPort = json["mqttPort"] as? Int,
              let mqttUsername = json["mqttUsername"] as? String,
              let mqttPassword = json["mqttPassword"] as? String,
              let expiresAt = json["expiresAt"] as? TimeInterval
        else {
            error = "邀请链接格式错误"
            return
        }
        
        // Check expiry
        if Date().timeIntervalSince1970 > expiresAt {
            error = "邀请链接已过期"
            return
        }
        
        teamCredentials = TeamJoinCredentials(
            teamID: teamID,
            mqttHost: mqttHost,
            mqttPort: UInt16(mqttPort),
            mqttUsername: mqttUsername,
            mqttPassword: mqttPassword
        )
        tokenValidated = true
    }
}

struct TeamJoinCredentials {
    let teamID: String
    let mqttHost: String
    let mqttPort: UInt16
    let mqttUsername: String
    let mqttPassword: String
}
```

- [ ] **Step 2: Verify build**

- [ ] **Step 3: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/Features/Join/
git commit -m "feat(ios): add JoinTeamView for invite link validation and username setup"
```

---

## Task 5: Invite Link Generation

**Files:**
- Create: `TeamClawMobile/TeamClawMobile/Features/Settings/InviteView.swift`
- Modify: `TeamClawMobile/TeamClawMobile/Features/Settings/SettingsView.swift`

- [ ] **Step 1: Create InviteView**

```swift
import SwiftUI

struct InviteView: View {
    @State private var generatedLink: String?
    @State private var isCopied = false
    
    var body: some View {
        List {
            Section("生成邀请链接") {
                Text("邀请链接一次性有效，24小时后过期。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                
                Button("生成新链接") {
                    generateLink()
                }
                
                if let link = generatedLink {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(link)
                            .font(.caption)
                            .textSelection(.enabled)
                            .lineLimit(2)
                        
                        HStack {
                            Button("复制") {
                                UIPasteboard.general.string = link
                                isCopied = true
                                DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                                    isCopied = false
                                }
                            }
                            
                            if isCopied {
                                Text("已复制")
                                    .font(.caption)
                                    .foregroundStyle(.green)
                            }
                            
                            Spacer()
                            
                            ShareLink(item: link) {
                                Label("分享", systemImage: "square.and.arrow.up")
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("邀请成员")
    }
    
    private func generateLink() {
        guard let creds = PairingManager.currentCredentials else { return }
        
        let expiresAt = Date().timeIntervalSince1970 + 86400 // 24 hours
        let payload: [String: Any] = [
            "mqttHost": creds.mqttHost,
            "mqttPort": Int(creds.mqttPort),
            "mqttUsername": creds.mqttUsername,
            "mqttPassword": creds.mqttPassword,
            "expiresAt": expiresAt
        ]
        
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let ticket = data.base64EncodedString()
                .addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)
        else { return }
        
        generatedLink = "teamclaw://join?ticket=\(ticket)&team=\(creds.teamID)"
    }
}
```

- [ ] **Step 2: Add invite + username sections to SettingsView**

In `SettingsView.swift`, add a new section before the existing "桌面端连接" section:

```swift
Section("个人资料") {
    HStack {
        Text("用户名")
        Spacer()
        NavigationLink {
            UsernameSettingView(pairingManager: pairingManager)
        } label: {
            Text(pairingManager.username.isEmpty ? "未设置" : pairingManager.username)
                .foregroundStyle(.secondary)
        }
    }
}

Section("团队") {
    NavigationLink("邀请成员") {
        InviteView()
    }
}
```

- [ ] **Step 3: Create UsernameSettingView**

Create `TeamClawMobile/TeamClawMobile/Features/Settings/UsernameSettingView.swift`:

```swift
import SwiftUI

struct UsernameSettingView: View {
    @ObservedObject var pairingManager: PairingManager
    @State private var name: String = ""
    @Environment(\.dismiss) private var dismiss
    
    var body: some View {
        Form {
            TextField("用户名", text: $name)
                .autocorrectionDisabled()
        }
        .navigationTitle("用户名")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("保存") {
                    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !trimmed.isEmpty {
                        pairingManager.updateUsername(trimmed)
                    }
                    dismiss()
                }
                .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .onAppear {
            name = pairingManager.username
        }
    }
}
```

- [ ] **Step 4: Verify build**

- [ ] **Step 5: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/Features/Settings/ TeamClawMobile/TeamClawMobile/Features/Join/
git commit -m "feat(ios): add invite link generation and username settings"
```

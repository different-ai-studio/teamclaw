import SwiftUI
import UIKit
import os
import AMUXCore
import AMUXUI

private let logger = Logger(subsystem: "tech.teamclaw.mobile", category: "MQTT")

struct ContentView: View {
    let pairing: PairingManager
    @State private var mqtt = MQTTService()
    @State private var hub: MQTTMessageHub
    @State private var teamclawService = TeamclawService()
    @State private var onboarding: AppOnboardingCoordinator
    /// Bridges push/deep-link "open session" intents into RootTabView's
    /// session NavigationStack (which owns `sessionsPath`).
    @State private var navigationRouter = NavigationRouter()
    @State private var isConnecting = false
    @State private var connectTask: Task<Void, Never>?
    /// One-shot legacy→CloudAPI session migration, run before the first
    /// `bootstrap()`. Nil when no cloud config is resolvable (Supabase
    /// fallback) — nothing to migrate. Cleared after it runs once.
    @State private var pendingSessionMigration: (@Sendable () async -> Void)?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.modelContext) private var modelContext

    init(pairing: PairingManager) {
        self.pairing = pairing
        let mqtt = MQTTService()
        _mqtt = State(initialValue: mqtt)
        _hub = State(initialValue: MQTTMessageHub(mqtt: mqtt))

        // Cloud API is the only client backend. Build the Cloud-API-backed
        // onboarding store from the resolved cloud endpoint; if none is
        // configured, surface a failing store rather than a Supabase fallback
        // (the Supabase SDK was removed in the cutover endgame). Existing
        // sessions persisted only in the old Supabase keychain are not migrated
        // — affected users re-authenticate once.
        if let cloudConfig = CloudAPIConfigurationStore.configuration() {
            let store = CloudAPIAppOnboardingStore(
                configuration: cloudConfig,
                storage: KeychainSessionStorage()
            )
            _onboarding = State(initialValue: AppOnboardingCoordinator(store: store))
        } else {
            _onboarding = State(
                initialValue: AppOnboardingCoordinator(
                    store: FailingOnboardingStore(
                        error: NSError(
                            domain: "CloudAPI", code: 0,
                            userInfo: [NSLocalizedDescriptionKey: "Cloud API is not configured."]
                        )
                    )
                )
            )
        }
        _pendingSessionMigration = State(initialValue: nil)
    }

    @ViewBuilder
    private var readyView: some View {
        RootTabView(
            mqtt: mqtt,
            hub: hub,
            pairing: pairing,
            teamclawService: teamclawService,
            activeTeam: onboarding.currentContext?.team,
            currentActorID: onboarding.currentContext?.memberActorID,
            onReconnect: {
                forceReconnect()
            },
            onSignOut: {
                signOut()
            },
            preferencesAPI: PushBootstrap.shared.preferencesAPI
        )
        .environment(onboarding)
        .environment(navigationRouter)
        .task {
            if let team = onboarding.currentContext?.team {
                OnboardingLocalCacheBootstrapper.ensureWorkspaceExists(team: team, modelContext: modelContext)
            }
            await connectMQTT()
        }
    }

    var body: some View {
        Group {
            switch onboarding.route {
            case .loading:
                LobsterSplashView()
            case .needsAuth:
                WelcomeView(coordinator: onboarding)
            case .createTeam:
                CreateTeamView(coordinator: onboarding)
            case .selectTeam:
                OrgTeamPickerView(coordinator: onboarding)
            case .ready:
                readyView
            case .failed:
                OnboardingErrorView(
                    message: onboarding.errorMessage ?? "Unknown setup error."
                ) {
                    Task { await onboarding.bootstrap() }
                }
            }
        }
        .task {
            // Seed the Cloud API SessionStore from any pre-existing Supabase
            // session exactly once, BEFORE the first bootstrap, so existing
            // users stay signed in across the cutover. No-op (nil) on the
            // Supabase fallback path.
            if let migrate = pendingSessionMigration {
                pendingSessionMigration = nil
                await migrate()
            }
            await onboarding.bootstrap()
        }
        .task {
            // Reconnect MQTT every time the auth provider rotates the
            // access token. MQTT uses the JWT as its CONNECT password
            // and the broker stops accepting publishes once the token
            // hits its ~1h expiry — without a reconnect the socket
            // appears live but every publish is silently dropped and
            // the user has no clue until they sign out + sign back in.
            // Supabase-swift auto-refreshes the session in the
            // background; this loop just listens for the resulting
            // `.tokenRefreshed` event and rebuilds the connection.
            for await _ in onboarding.store.tokenRefreshes() {
                logger.info("Auth token refreshed; reconnecting MQTT")
                guard pairing.isPaired, onboarding.route == .ready else { continue }
                forceReconnect()
            }
        }
        .onChange(of: onboarding.pendingCreatedTeam) { _, createdTeam in
            guard let createdTeam else { return }
            OnboardingLocalCacheBootstrapper.prime(createdTeam: createdTeam, modelContext: modelContext)
        }
        .onChange(of: pairing.isPaired) { _, paired in
            guard paired else { return }
            Task { await connectMQTT() }
        }
        .onChange(of: onboarding.teamRuntimeContext?.team.id) { _, newID in
            // start() is keyed on the active team and is idempotent
            // (cancels any prior listener), so a single onChange covers
            // first appearance + team switches.
            guard let id = newID, let runtime = onboarding.teamRuntimeContext else { return }
            teamclawService.start(
                mqtt: mqtt,
                hub: hub,
                teamId: id,
                peerId: "ios-\(pairing.authToken.prefix(6))",
                modelContext: modelContext,
                connectedAgentsStore: runtime.connectedAgentsStore,
                currentActorID: runtime.memberActorID,
                messagesRepository: runtime.messagesRepo
            )
        }
        .onReceive(NotificationCenter.default.publisher(for: .amuxAuthCallbackReceived)) { notification in
            guard let url = notification.object as? URL else { return }
            Task { await onboarding.handleAuthCallback(url: url) }
        }
        .onReceive(NotificationCenter.default.publisher(for: .amuxOpenSession)) { note in
            guard let sid = note.userInfo?["session_id"] as? String else { return }
            // Record the intent on the shared router. RootTabView observes
            // `pendingSessionID`, switches to the Sessions tab, and pushes the
            // session onto its NavigationStack. We record even before
            // onboarding is `.ready` (cold launch from a push): RootTabView
            // consumes any already-pending intent when it first mounts, so the
            // deep link survives the launch-time onboarding gap.
            logger.info("Open-session deep link received; routing to \(sid, privacy: .public)")
            navigationRouter.openSession(sid)
        }
        .onChange(of: scenePhase) { _, phase in
            // iOS freezes sockets when backgrounded but rarely delivers a
            // clean disconnect callback, so `connectionState` can stay
            // `.connected` on a dead socket ("zombie"). On foreground we
            // force a full reconnect regardless of reported state; the
            // SessionDetailViewModel loop will resubscribe and trigger an
            // incremental history sync once MQTT is back up.
            if phase == .active && pairing.isPaired && onboarding.route == .ready {
                logger.info("App became active, forcing MQTT reconnect…")
                forceReconnect()
            }
        }
    }

    private func signOut() {
        connectTask?.cancel()
        isConnecting = false
        Task {
            await mqtt.disconnect()
            await onboarding.signOutAndWipeCache(modelContext: modelContext)
        }
    }

    /// User-initiated reconnect: cancels any in-flight connect Task (so a
    /// hung MQTTService.connect can't leave `isConnecting` stuck `true`),
    /// clears the flag, then disconnects and reconnects.
    private func forceReconnect() {
        connectTask?.cancel()
        isConnecting = false
        connectTask = Task {
            await mqtt.disconnect()
            await connectMQTT()
        }
    }

    /// One-shot attach of an MQTTTraceRecorder to the hub. Idempotent —
    /// re-attaching across reconnects keeps appending to the same file,
    /// which is what we want for cross-session captures.
    private func attachTraceRecorder() async {
        let docs = try? FileManager.default.url(
            for: .documentDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        guard let docs else { return }
        let url = docs.appendingPathComponent("teamclaw-trace.jsonl")
        let recorder = MQTTTraceRecorder(fileURL: url)
        do {
            try await recorder.start()
            await hub.attachRecorder(recorder)
            logger.info("MQTT trace recording enabled → \(url.path)")
        } catch {
            logger.error("Failed to start MQTT trace recorder: \(error)")
        }
    }

    private func connectMQTT() async {
        guard onboarding.route == .ready, pairing.isPaired, !isConnecting else { return }
        isConnecting = true
        defer { isConnecting = false }

        let token: String
        do {
            token = try await onboarding.accessToken()
        } catch {
            logger.error("Failed to get access token for MQTT: \(error)")
            return
        }

        let userID = onboarding.currentContext?.memberActorID ?? "teamclaw-ios"
        let clientId = "teamclaw-ios-\(userID.prefix(8))"
        logger.info("Connecting to \(pairing.brokerHost):\(pairing.brokerPort) tls=\(pairing.useTLS)")
        do {
            try await mqtt.connect(
                host: pairing.brokerHost, port: pairing.brokerPort,
                username: userID, password: token,
                clientId: clientId, useTLS: pairing.useTLS
            )
            logger.info("MQTT connected")
            // Hub consumes MQTTService.messages() once and fans out per
            // topic-filter to every downstream consumer. Restart on every
            // (re)connect so the listener picks up the fresh upstream
            // stream — `start()` cancels any prior task.
            await hub.start()
            // Debug-only MQTT trace capture: enable by writing
            // `UserDefaults.standard.set(true, forKey: "TeamclawRecordMQTT")`
            // before launch. Captured JSONL lands in
            // Documents/teamclaw-trace.jsonl on the device/simulator.
            // Used to capture Phase 4 reducer fixtures from a real session.
            if UserDefaults.standard.bool(forKey: "TeamclawRecordMQTT") ||
                UserDefaults.standard.bool(forKey: "AMUXRecordMQTT") {
                await attachTraceRecorder()
            }
            // Coordinator-driven team runtime preparation runs from
            // RootTabView's .task; TeamclawService start follows from
            // the onChange(teamRuntimeContext) hook above.
        } catch {
            logger.error("MQTT connect failed: \(error)")
        }
    }
}

private actor FailingOnboardingStore: AppOnboardingStore {
    let error: Error

    init(error: Error) {
        self.error = error
    }

    func ensureSession() async throws {
        throw error
    }

    func loadBootstrap() async throws -> AppBootstrap {
        throw error
    }

    func createTeam(named name: String) async throws -> CreatedTeam {
        throw error
    }
    func listAllMyTeams() async throws -> [MembershipTeam] { throw error }
    func switchActiveTeam(teamID: String) async throws -> TeamSwitchResult { throw error }

    func signIn(email: String, password: String) async throws { throw error }
    func signUp(email: String, password: String) async throws { throw error }
    func sendEmailOTP(email: String) async throws { throw error }
    func verifyOTP(email: String, token: String) async throws { throw error }
    func sendPhoneOTP(phone: String) async throws { throw error }
    func verifyPhoneOTP(phone: String, token: String) async throws { throw error }
    func signInWithAppleCredential(idToken: String, nonce: String) async throws { throw error }
    func signInWithGoogle() async throws { throw error }
    func handleAuthCallback(url: URL) async throws { throw error }
    func accessToken() async throws -> String { throw error }
    func signOut() async throws { throw error }
    func signInAnonymously() async throws { throw error }
    func isAnonymous() async -> Bool { false }
    func currentUserEmail() async -> String? { nil }
    func upgradeWithPassword(email: String, password: String) async throws { throw error }
    func sendUpgradeEmailOTP(email: String) async throws { throw error }
    func verifyUpgradeEmailOTP(email: String, token: String) async throws { throw error }
    func sendUpgradePhoneOTP(phone: String) async throws { throw error }
    func verifyUpgradePhoneOTP(phone: String, token: String) async throws { throw error }
    func upgradeWithAppleCredential(idToken: String, nonce: String) async throws { throw error }
    func claimInvite(token: String) async throws -> ClaimResult { throw error }
    func setSession(refreshToken: String) async throws { throw error }
    nonisolated func tokenRefreshes() -> AsyncStream<Void> { AsyncStream { $0.finish() } }
}

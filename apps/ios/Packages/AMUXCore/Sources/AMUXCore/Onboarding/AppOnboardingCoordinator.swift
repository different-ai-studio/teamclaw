import Foundation
import Observation
import SwiftData

public struct TeamSummary: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let slug: String
    public let role: String

    public init(id: String, name: String, slug: String, role: String) {
        self.id = id
        self.name = name
        self.slug = slug
        self.role = role
    }
}

public struct AppBootstrap: Equatable, Sendable {
    public let memberActorID: String?
    public let teams: [TeamSummary]
    /// Map of team id → the user's member-actor id within that team. A user
    /// has a distinct actor row per team they belong to, so this lets the
    /// coordinator switch the active context to a specific team (e.g. the
    /// one a freshly-claimed invite landed in) without re-querying the
    /// backend.
    public let memberActorIDByTeam: [String: String]

    public init(memberActorID: String?,
                teams: [TeamSummary],
                memberActorIDByTeam: [String: String] = [:]) {
        self.memberActorID = memberActorID
        self.teams = teams
        self.memberActorIDByTeam = memberActorIDByTeam
    }
}

public struct CreatedTeam: Equatable, Sendable {
    public let team: TeamSummary
    public let memberActorID: String
    public let workspaceID: String
    public let workspaceName: String

    public init(team: TeamSummary, memberActorID: String, workspaceID: String, workspaceName: String) {
        self.team = team
        self.memberActorID = memberActorID
        self.workspaceID = workspaceID
        self.workspaceName = workspaceName
    }
}

public struct AppContext: Equatable, Sendable {
    public let team: TeamSummary
    public let memberActorID: String

    public init(team: TeamSummary, memberActorID: String) {
        self.team = team
        self.memberActorID = memberActorID
    }
}

public enum AuthRequired: Error {
    case notAuthenticated
}

public enum AppOnboardingRoute: Equatable, Sendable {
    case loading
    case needsAuth
    case createTeam
    case ready
    case failed
}

public protocol AppOnboardingStore: Sendable {
    func ensureSession() async throws
    func loadBootstrap() async throws -> AppBootstrap
    func createTeam(named name: String) async throws -> CreatedTeam
    /// Direct invite-claim entry used by bootstrap so a freshly-anonymous
    /// user can join the inviter's team before the auto-create-team branch
    /// fires (otherwise they end up with an orphan team alongside the one
    /// they actually wanted to join).
    func claimInvite(token: String) async throws -> ClaimResult

    // Auth sign-in methods
    func signIn(email: String, password: String) async throws
    func signUp(email: String, password: String) async throws
    func sendEmailOTP(email: String) async throws
    func verifyOTP(email: String, token: String) async throws
    func signInWithAppleCredential(idToken: String, nonce: String) async throws
    func signInWithGoogle() async throws
    func signInAnonymously() async throws
    func handleAuthCallback(url: URL) async throws
    func accessToken() async throws -> String
    func signOut() async throws

    /// Establish a Supabase session from a refresh_token (e.g. one returned
    /// by `claim_team_invite` for an agent claim or member-reinvite claim).
    /// Used by `claimInviteSmart` to land on the target's existing user_id
    /// without minting a fresh anonymous user.
    func setSession(refreshToken: String) async throws

    // True iff the current session belongs to an anonymous user
    // (`auth.users.is_anonymous`). Returns false when no session exists.
    func isAnonymous() async -> Bool

    // Promote the current anonymous session to a permanent account by
    // attaching credentials. Same auth.users.id, so all team / actor / access
    // rows the user accumulated as anonymous are preserved.
    func upgradeWithPassword(email: String, password: String) async throws
    func upgradeWithAppleCredential(idToken: String, nonce: String) async throws

    /// Emits each time the underlying auth provider rotates the access
    /// token. Consumers (notably the MQTT layer) must rebuild any
    /// long-lived connection whose password was set to a prior JWT;
    /// otherwise the broker silently rejects publishes once the token
    /// hits its expiry (~1h on Supabase default config) and the user is
    /// left with a dead-looking app that needs a relogin to recover.
    nonisolated func tokenRefreshes() -> AsyncStream<Void>
}

@Observable
@MainActor
public final class AppOnboardingCoordinator {
    public var route: AppOnboardingRoute = .loading
    public var currentContext: AppContext?
    public var pendingCreatedTeam: CreatedTeam?
    public var errorMessage: String?
    public var pendingEmailOTPEmail: String?
    public var isBusy = false
    /// True iff the current session is an anonymous Supabase user. UI uses
    /// this to surface the "upgrade your account" affordance.
    public var isAnonymous: Bool = false
    /// Invite token captured pre-auth (e.g. user pasted a link on the
    /// onboarding screen). Stashed here so it can replay through the
    /// existing `amuxInviteTokenReceived` pipeline after sign-in.
    public var pendingInviteToken: String?

    /// Active team-scoped runtime state. Built by `prepareTeamRuntime` once
    /// the user has a `currentContext`, replaced atomically when the active
    /// team changes, nilled on sign-out. Views read team-scoped repositories
    /// and observable stores from here instead of constructing their own.
    public private(set) var teamRuntimeContext: TeamRuntimeContext?

    public let store: AppOnboardingStore

    public init(store: AppOnboardingStore) {
        self.store = store
    }

    // MARK: - Team-scoped runtime lifecycle

    /// Build (or reuse) the team-scoped repository + store bundle for the
    /// active context. Idempotent: returns immediately when the existing
    /// context already covers `currentContext.team`. Nils the runtime when
    /// `currentContext` is absent (e.g. sign-out, no team yet).
    ///
    /// Repository construction reads from `Info.plist` via
    /// `SupabaseProjectConfiguration.fromMainBundle()`; if the actor or
    /// access repo can't be built, `teamRuntimeContext` stays nil and
    /// callers should surface the configuration error elsewhere.
    public func prepareTeamRuntime(modelContext: ModelContext) async {
        guard let ctx = currentContext else {
            teamRuntimeContext = nil
            return
        }
        if let existing = teamRuntimeContext, existing.team.id == ctx.team.id {
            return
        }

        guard let actorRepo = try? SupabaseActorRepository(),
              let agentAccessRepo = try? SupabaseAgentAccessRepository() else {
            teamRuntimeContext = nil
            return
        }

        let actorStore = ActorStore(teamID: ctx.team.id,
                                    repository: actorRepo,
                                    modelContext: modelContext)
        let connectedAgentsStore = ConnectedAgentsStore(teamID: ctx.team.id,
                                                       repository: agentAccessRepo)
        // Eager reload so first-frame consumers (member pickers, session
        // composer @-suggestions) have rows without bouncing through an
        // empty state.
        await actorStore.reload()
        await connectedAgentsStore.reload()

        teamRuntimeContext = TeamRuntimeContext(
            team: ctx.team,
            memberActorID: ctx.memberActorID,
            actorStore: actorStore,
            connectedAgentsStore: connectedAgentsStore,
            sessionIDsRepo: try? SupabaseSessionIDsRepository(),
            sessionsRepo: try? SupabaseSessionsRepository(),
            agentRuntimesRepo: try? SupabaseAgentRuntimesRepository(),
            workspacesRepo: try? SupabaseWorkspaceRepository(),
            agentAccessRepo: agentAccessRepo
        )
    }

    /// Drop the current team runtime. Used on sign-out and on team switches
    /// before rebuilding for the next team.
    public func clearTeamRuntime() {
        teamRuntimeContext = nil
    }

    /// Wipe every SwiftData row owned by the signed-in user, then sign out.
    ///
    /// Every model in the container is a snapshot of remote state for the
    /// current user; leaving rows around lets the next signed-in user (or
    /// the same user after switching teams via invite) see stale actors,
    /// sessions, and workspaces until a per-team reload overwrites them.
    /// The ones we don't actively reload (other-team rows) never get cleared
    /// otherwise.
    public func signOutAndWipeCache(modelContext: ModelContext) async {
        do {
            try modelContext.delete(model: Runtime.self)
            try modelContext.delete(model: AgentEvent.self)
            try modelContext.delete(model: CachedActor.self)
            try modelContext.delete(model: CachedAgentRuntime.self)
            try modelContext.delete(model: Workspace.self)
            try modelContext.delete(model: Session.self)
            try modelContext.delete(model: SessionMessage.self)
            try modelContext.delete(model: SessionIdea.self)
            try modelContext.save()
        } catch {
            // Sign-out path; surface only via errorMessage on the
            // signOut() flow itself.
        }
        await signOut()
    }

    public func bootstrap(preferringTeamID: String? = nil) async {
        guard !isBusy else { return }
        isBusy = true
        route = .loading
        errorMessage = nil
        defer { isBusy = false }

        let bootStart = Date()
        let bootInterval = onboardingSignposter.beginInterval("bootstrap")
        defer {
            onboardingSignposter.endInterval("bootstrap", bootInterval)
            let ms = Int(Date().timeIntervalSince(bootStart) * 1000)
            onboardingLogger.info("bootstrap total: \(ms) ms")
        }

        do {
            try await measureOnboarding("ensureSession") { try await store.ensureSession() }
            isAnonymous = await measureOnboarding("isAnonymous") { await store.isAnonymous() }
            var bootstrap = try await measureOnboarding("loadBootstrap") { try await store.loadBootstrap() }
            pendingCreatedTeam = nil
            var preferred = preferringTeamID

            // If a pending invite token is sitting on the coordinator (the
            // user pasted it in ChooseAuthView before sign-in), claim it
            // now — BEFORE the anonymous auto-create branch — so we never
            // strand the user with an orphan workspace alongside the team
            // they actually wanted to join. After claim, re-load bootstrap
            // and prefer the claimed team for the active context.
            if let token = pendingInviteToken, !token.isEmpty {
                do {
                    let result = try await measureOnboarding("claimInvite") {
                        try await store.claimInvite(token: token)
                    }
                    pendingInviteToken = nil
                    preferred = preferred ?? result.teamID
                    bootstrap = try await measureOnboarding("loadBootstrap.afterClaim") {
                        try await store.loadBootstrap()
                    }
                } catch {
                    // Claim failed (expired/consumed token, network blip,
                    // etc.). The user explicitly asked to join via invite —
                    // falling through to the anonymous auto-create branch
                    // would silently strand them in a fresh orphan team
                    // alongside an ambiguous error. Roll back the just-
                    // created anonymous session and bounce back to needsAuth
                    // with the error message so they can paste a new token.
                    pendingInviteToken = nil
                    errorMessage = error.localizedDescription
                    try? await store.signOut()
                    currentContext = nil
                    isAnonymous = false
                    route = .needsAuth
                    return
                }
            }

            // Pick the active team: when a preferred team is requested (e.g.
            // right after claimInvite) and the user actually belongs to it,
            // honor the request so the UI lands on that team instead of the
            // arbitrary first one. Fall back to the first team otherwise.
            let pickedTeam: TeamSummary? = {
                if let preferred,
                   let match = bootstrap.teams.first(where: { $0.id == preferred }) {
                    return match
                }
                return bootstrap.teams.first
            }()
            let pickedActorID: String? = {
                guard let team = pickedTeam else { return nil }
                return bootstrap.memberActorIDByTeam[team.id] ?? bootstrap.memberActorID
            }()

            if let team = pickedTeam, let memberActorID = pickedActorID {
                currentContext = AppContext(team: team, memberActorID: memberActorID)
                route = .ready
                return
            }

            // No team yet. Auto-create one after invite handling so newly
            // registered users who were not invited anywhere land directly
            // in the app instead of getting stuck on the manual team screen.
            let name = RandomTeamName.generate()
            let created = try await measureOnboarding("createTeam.auto") {
                try await store.createTeam(named: name)
            }
            pendingCreatedTeam = created
            currentContext = AppContext(team: created.team, memberActorID: created.memberActorID)
            route = .ready
        } catch is AuthRequired {
            currentContext = nil
            isAnonymous = false
            route = .needsAuth
        } catch {
            currentContext = nil
            isAnonymous = false
            route = .failed
            errorMessage = error.localizedDescription
        }
    }

    public func createTeam(named rawName: String) async {
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            errorMessage = "Team name is required."
            route = .createTeam
            return
        }

        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }

        do {
            let created = try await store.createTeam(named: name)
            pendingCreatedTeam = created
            currentContext = AppContext(team: created.team, memberActorID: created.memberActorID)
            route = .ready
        } catch {
            route = .createTeam
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Auth sign-in

    public func signIn(email: String, password: String) async {
        await performAuth { try await self.store.signIn(email: email, password: password) }
    }

    public func signUp(email: String, password: String) async {
        await performAuth { try await self.store.signUp(email: email, password: password) }
    }

    public func sendEmailOTP(email: String) async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            try await store.sendEmailOTP(email: email)
            pendingEmailOTPEmail = email
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func verifyOTP(email: String, token: String) async {
        await performAuth { try await self.store.verifyOTP(email: email, token: token) }
    }

    public func resetPendingEmailOTP() {
        pendingEmailOTPEmail = nil
        errorMessage = nil
    }

    public func signInWithApple() async {
#if os(iOS)
        await performAuth {
            let (idToken, nonce) = try await AppleSignInHandler.shared.request()
            try await self.store.signInWithAppleCredential(idToken: idToken, nonce: nonce)
        }
#endif
    }

    public func signInWithGoogle() async {
        await performAuth { try await self.store.signInWithGoogle() }
    }

    public func signInAnonymously() async {
        await performAuth { try await self.store.signInAnonymously() }
    }

    /// Sign in anonymously and immediately claim an invite token in one go,
    /// keeping the UI on the current screen on failure. The default
    /// `signInAnonymously` → `bootstrap` path transitions `route` through
    /// `.loading`, which rebuilds the whole onboarding view tree (including
    /// any sheet that was open) — bad UX when the user wants to retry the
    /// paste without re-navigating. This method only flips `route` once,
    /// on success, and leaves it unchanged on failure so the calling sheet
    /// can stay open and surface `errorMessage` inline.
    public func signInAnonymouslyAndClaim(token: String) async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil

        do {
            try await store.signInAnonymously()
        } catch {
            errorMessage = error.localizedDescription
            isBusy = false
            return
        }

        do {
            let result = try await store.claimInvite(token: token)
            // Success → run bootstrap with the joined team preferred. The
            // transient `.loading` flicker here is fine because the sheet
            // is about to be dismissed by the caller anyway.
            isBusy = false
            await bootstrap(preferringTeamID: result.teamID)
        } catch {
            // Roll back the just-created anonymous session so we don't
            // strand the user with an authenticated-but-team-less Supabase
            // user. Critically we DON'T touch `route` here — the calling
            // sheet stays mounted and re-renders with the new errorMessage.
            errorMessage = error.localizedDescription
            try? await store.signOut()
            isBusy = false
        }
    }

    /// Claim an invite without knowing in advance whether it's a fresh
    /// member invite (needs anonymous signin first) or an agent / member
    /// re-invite (returns a refresh_token that we use to set the session).
    /// Tries the refresh-token path first by attempting an unauthenticated
    /// claim; if the RPC says auth is required, falls back to the existing
    /// anon-then-claim path.
    public func claimInviteSmart(token: String) async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil

        // Make sure no stale session lingers — re-invite should land us on
        // the target's user_id, not whoever was signed in before.
        try? await store.signOut()

        let result: ClaimResult
        do {
            result = try await store.claimInvite(token: token)
        } catch {
            // Most likely: 'member claim requires authentication' (42501).
            // The token is unconsumed — fall back to anon-then-claim.
            isBusy = false
            await signInAnonymouslyAndClaim(token: token)
            return
        }

        if let rt = result.refreshToken {
            do {
                try await store.setSession(refreshToken: rt)
            } catch {
                // Claim succeeded (token consumed) but session adoption
                // failed — falling back would re-attempt with a spent
                // token and produce a misleading error. Surface the real
                // failure instead and require a fresh invite.
                errorMessage = "Sign-in failed after redeeming the invite. Ask the team admin for a fresh link. (\(error.localizedDescription))"
                isBusy = false
                return
            }
            isBusy = false
            await bootstrap(preferringTeamID: result.teamID)
            return
        }

        // No refresh token: fresh-member invite that succeeded
        // unauthenticated (shouldn't normally happen, but bootstrap anyway).
        isBusy = false
        await bootstrap(preferringTeamID: result.teamID)
    }

    // MARK: - Anonymous account upgrade

    /// Promote the current anonymous session to an email/password account.
    /// On success the user_id is unchanged, so existing team / actor rows are
    /// retained. Triggers a re-bootstrap to refresh `isAnonymous`.
    public func upgradeWithPassword(email: String, password: String) async {
        await performAuth { try await self.store.upgradeWithPassword(email: email, password: password) }
    }

    /// Same as `upgradeWithPassword` but linking an Apple identity instead.
    public func upgradeWithApple() async {
#if os(iOS)
        await performAuth {
            let (idToken, nonce) = try await AppleSignInHandler.shared.request()
            try await self.store.upgradeWithAppleCredential(idToken: idToken, nonce: nonce)
        }
#endif
    }

    public func accessToken() async throws -> String {
        try await store.accessToken()
    }

    public func signOut() async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        do {
            try await store.signOut()
        } catch {
            errorMessage = error.localizedDescription
        }
        currentContext = nil
        teamRuntimeContext = nil
        pendingCreatedTeam = nil
        pendingEmailOTPEmail = nil
        isAnonymous = false
        route = .needsAuth
        isBusy = false
    }

    public func handleAuthCallback(url: URL) async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        do {
            try await store.handleAuthCallback(url: url)
            pendingEmailOTPEmail = nil
            isBusy = false
            await bootstrap()
        } catch {
            isBusy = false
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Private helpers

    private func performAuth(_ action: @escaping () async throws -> Void) async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        do {
            try await action()
            isBusy = false
            await bootstrap()
        } catch {
            isBusy = false
            errorMessage = error.localizedDescription
        }
    }
}

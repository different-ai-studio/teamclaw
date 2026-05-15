import Foundation
import Supabase

public enum SupabaseProjectConfigurationError: LocalizedError {
    case missingURL
    case invalidURL(String)
    case missingPublishableKey

    public var errorDescription: String? {
        switch self {
        case .missingURL:
            return "SUPABASE_URL is missing from Info.plist."
        case .invalidURL(let value):
            return "SUPABASE_URL is invalid: \(value)"
        case .missingPublishableKey:
            return "SUPABASE_PUBLISHABLE_KEY is missing from Info.plist."
        }
    }
}

public enum SignUpOutcome: Error, LocalizedError {
    case emailAlreadyInUse
    case emailConfirmationRequired

    public var errorDescription: String? {
        switch self {
        case .emailAlreadyInUse:
            return "This email is already registered. Try signing in instead."
        case .emailConfirmationRequired:
            return "Check your inbox — we sent you a confirmation link."
        }
    }
}

public struct SupabaseProjectConfiguration: Sendable {
    public let url: URL
    public let publishableKey: String

    public init(url: URL, publishableKey: String) {
        self.url = url
        self.publishableKey = publishableKey
    }

    /// Resolve the effective Supabase config. User-overridden values in
    /// UserDefaults (set via the Settings "Supabase Server" editor) win over
    /// Info.plist bake-ins, which in turn win over no config at all.
    public static func fromMainBundle() throws -> Self {
        let bundle = Bundle.main
        let defaults = UserDefaults.standard

        let rawURL = (SupabaseServerStore.storedURL(in: defaults)
                      ?? bundle.object(forInfoDictionaryKey: "SUPABASE_URL") as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawURL.isEmpty else {
            throw SupabaseProjectConfigurationError.missingURL
        }
        guard let url = URL(string: rawURL) else {
            throw SupabaseProjectConfigurationError.invalidURL(rawURL)
        }
        let publishableKey = (SupabaseServerStore.storedKey(in: defaults)
                              ?? bundle.object(forInfoDictionaryKey: "SUPABASE_PUBLISHABLE_KEY") as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !publishableKey.isEmpty else {
            throw SupabaseProjectConfigurationError.missingPublishableKey
        }
        return Self(url: url, publishableKey: publishableKey)
    }
}

/// Persists Supabase URL + publishable key overrides in UserDefaults. Falls
/// back to Info.plist bake-ins when nothing is stored. Changing values requires
/// an app relaunch — existing Supabase clients are captured with the old
/// config.
public enum SupabaseServerStore {
    public static let urlKey = "teamclaw_supabase_url"
    public static let keyKey = "teamclaw_supabase_key"
    private static let legacyURLKey = "amux_supabase_url"
    private static let legacyKeyKey = "amux_supabase_key"

    public static func currentURL() -> String {
        storedURL(in: .standard)
            ?? Bundle.main.object(forInfoDictionaryKey: "SUPABASE_URL") as? String
            ?? ""
    }

    public static func currentKey() -> String {
        storedKey(in: .standard)
            ?? Bundle.main.object(forInfoDictionaryKey: "SUPABASE_PUBLISHABLE_KEY") as? String
            ?? ""
    }

    public static func save(url: String, key: String) {
        let d = UserDefaults.standard
        d.set(url.trimmingCharacters(in: .whitespacesAndNewlines), forKey: urlKey)
        d.set(key.trimmingCharacters(in: .whitespacesAndNewlines), forKey: keyKey)
    }

    public static func storedURL(in defaults: UserDefaults) -> String? {
        defaults.string(forKey: urlKey) ?? defaults.string(forKey: legacyURLKey)
    }

    public static func storedKey(in defaults: UserDefaults) -> String? {
        defaults.string(forKey: keyKey) ?? defaults.string(forKey: legacyKeyKey)
    }
}

public actor SupabaseAppOnboardingStore: AppOnboardingStore {
    private let client: SupabaseClient

    public init(configuration: SupabaseProjectConfiguration) {
        self.client = SupabaseClient(
            supabaseURL: configuration.url,
            supabaseKey: configuration.publishableKey
        )
    }

    public init() throws {
        let configuration = try SupabaseProjectConfiguration.fromMainBundle()
        self.client = SupabaseClient(
            supabaseURL: configuration.url,
            supabaseKey: configuration.publishableKey
        )
    }

    public func ensureSession() async throws {
        // Both authenticated and anonymous sessions are valid. Only the
        // absence of a session counts as "needs auth" — the WelcomeView /
        // ChooseAuthView flow surfaces sign-in vs anonymous.
        guard client.auth.currentSession != nil else {
            throw AuthRequired.notAuthenticated
        }
    }

    public func isAnonymous() async -> Bool {
        client.auth.currentSession?.user.isAnonymous ?? false
    }

    public func loadBootstrap() async throws -> AppBootstrap {
        let client = self.client
        // `auth.session` triggers a JWT refresh round-trip when the cached
        // token is past/near expiry — split into its own span so cold-start
        // refresh latency is visible separately from the PostgREST queries.
        let session = try await measureOnboarding("loadBootstrap.session") {
            try await client.auth.session
        }
        let userID = session.user.id.uuidString.lowercased()

        // Fetch every member-actor row for the user — a user has one
        // member-actor per team they belong to (auto-created on team join /
        // claim-invite). The previous `limit(1)` only ever surfaced one
        // team, so a user who joined a team via invite stayed pinned to
        // their original auto-created team.
        let actors: [MemberRow] = try await measureOnboarding("loadBootstrap.actors") {
            try await client
                .from("actors")
                .select("id")
                .eq("user_id", value: userID)
                .eq("actor_type", value: "member")
                .execute()
                .value
        }

        guard !actors.isEmpty else {
            return AppBootstrap(memberActorID: nil, teams: [], memberActorIDByTeam: [:])
        }

        let actorIDs = actors.map(\.id)
        let memberships: [MembershipRow] = try await measureOnboarding("loadBootstrap.memberships") {
            try await client
                .from("team_members")
                .select(
                    """
                    role,
                    member_id,
                    teams!inner (
                      id,
                      name,
                      slug
                    )
                    """
                )
                .in("member_id", values: actorIDs)
                .execute()
                .value
        }

        // De-duplicate teams by id while preserving the first-seen membership
        // (role + the actor id that membership was attached to).
        var teamByID: [String: TeamSummary] = [:]
        var memberByTeam: [String: String] = [:]
        var orderedTeams: [TeamSummary] = []
        for m in memberships {
            if teamByID[m.teams.id] == nil {
                let t = TeamSummary(id: m.teams.id, name: m.teams.name, slug: m.teams.slug, role: m.role)
                teamByID[m.teams.id] = t
                orderedTeams.append(t)
            }
            // Last writer wins is fine here — the same team won't have two
            // distinct member-actor rows for the same user under normal
            // flows; the pre-existing data invariant is one-actor-per-team.
            memberByTeam[m.teams.id] = m.memberID
        }

        let primaryActorID = orderedTeams.first.flatMap { memberByTeam[$0.id] }
        return AppBootstrap(
            memberActorID: primaryActorID,
            teams: orderedTeams,
            memberActorIDByTeam: memberByTeam
        )
    }

    public func createTeam(named name: String) async throws -> CreatedTeam {
        let rows: [CreatedTeamRow] = try await client
            .rpc(
                "create_team",
                params: ["p_name": name]
            )
            .execute()
            .value

        guard let row = rows.first else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: [], debugDescription: "create_team returned no rows")
            )
        }

        return CreatedTeam(
            team: TeamSummary(
                id: row.teamID,
                name: row.teamName,
                slug: row.teamSlug,
                role: row.role
            ),
            memberActorID: row.memberID,
            workspaceID: row.workspaceID,
            workspaceName: row.workspaceName
        )
    }

    public func signIn(email: String, password: String) async throws {
        try await client.auth.signIn(email: email, password: password)
    }

    public func signUp(email: String, password: String) async throws {
        let response = try await client.auth.signUp(email: email, password: password)
        // Supabase returns 200 (no error, no session) in two cases we must
        // surface explicitly — otherwise performAuth() falls through to
        // bootstrap(), which silently routes back to .needsAuth and unmounts
        // the LoginView with no error message:
        //   • emailAlreadyInUse: anti-enumeration. Returned User has empty
        //     identities.
        //   • emailConfirmationRequired: real new user, but project requires
        //     email confirmation before issuing a session.
        guard response.session == nil else { return }
        let identities = response.user.identities ?? []
        throw identities.isEmpty
            ? SignUpOutcome.emailAlreadyInUse
            : SignUpOutcome.emailConfirmationRequired
    }

    public func sendEmailOTP(email: String) async throws {
        // Supabase decides whether this email contains a link or a code from
        // the Auth email template: use {{ .Token }} for a 6-digit OTP.
        try await client.auth.signInWithOTP(
            email: email,
            redirectTo: URL(string: "teamclaw://auth-callback"),
            shouldCreateUser: true
        )
    }

    public func verifyOTP(email: String, token: String) async throws {
        do {
            try await client.auth.verifyOTP(email: email, token: token, type: .email)
        } catch {
            try await client.auth.verifyOTP(email: email, token: token, type: .signup)
        }
    }

    public func signInWithAppleCredential(idToken: String, nonce: String) async throws {
        try await client.auth.signInWithIdToken(
            credentials: .init(provider: .apple, idToken: idToken, nonce: nonce)
        )
    }

    public func signInWithGoogle() async throws {
        try await client.auth.signInWithOAuth(
            provider: .google,
            redirectTo: URL(string: "teamclaw://auth-callback"),
            scopes: "email profile"
        )
    }

    public func signInAnonymously() async throws {
        _ = try await client.auth.signInAnonymously()
    }

    /// Establish a Supabase session from a `refresh_token` returned by
    /// `claim_team_invite`. Used by the member-reinvite flow where the
    /// caller may be unauthenticated and the RPC returns a token bound to
    /// the target's existing `user_id` — no new auth.users row is created.
    public func setSession(refreshToken: String) async throws {
        _ = try await client.auth.refreshSession(refreshToken: refreshToken)
    }

    public func upgradeWithPassword(email: String, password: String) async throws {
        _ = try await client.auth.update(
            user: UserAttributes(email: email, password: password)
        )
    }

    public func upgradeWithAppleCredential(idToken: String, nonce: String) async throws {
        _ = try await client.auth.linkIdentityWithIdToken(
            credentials: .init(provider: .apple, idToken: idToken, nonce: nonce)
        )
    }

    public func handleAuthCallback(url: URL) async throws {
        _ = try await client.auth.session(from: url)
    }

    public func accessToken() async throws -> String {
        try await client.auth.session.accessToken
    }

    public nonisolated func tokenRefreshes() -> AsyncStream<Void> {
        AsyncStream { continuation in
            let task = Task { [client] in
                for await change in client.auth.authStateChanges {
                    if change.event == .tokenRefreshed {
                        continuation.yield()
                    }
                    if Task.isCancelled { break }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func signOut() async throws {
        try await client.auth.signOut()
    }

    public func claimInvite(token: String) async throws -> ClaimResult {
        // Same `claim_team_invite` RPC SupabaseActorRepository uses; surfaced
        // here so coordinator.bootstrap can claim before auto-creating an
        // anonymous team and stranding the user with an orphan workspace.
        let rows: [BootstrapClaimResultRow] = try await client
            .rpc("claim_team_invite", params: BootstrapClaimInviteParams(token: token))
            .execute()
            .value
        guard let row = rows.first else {
            throw NSError(domain: "AMUX.Onboarding", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "claim_team_invite returned no rows"])
        }
        return row.asClaimResult
    }
}

private struct BootstrapClaimInviteParams: Encodable {
    let token: String
    enum CodingKeys: String, CodingKey { case token = "p_token" }
}

private struct BootstrapClaimResultRow: Decodable, Sendable {
    let actorID: String; let teamID: String
    let actorType: String; let displayName: String
    let refreshToken: String?
    enum CodingKeys: String, CodingKey {
        case actorID = "actor_id", teamID = "team_id"
        case actorType = "actor_type", displayName = "display_name"
        case refreshToken = "refresh_token"
    }
    var asClaimResult: ClaimResult {
        ClaimResult(actorID: actorID, teamID: teamID,
                    actorType: actorType, displayName: displayName,
                    refreshToken: refreshToken)
    }
}

private struct MemberRow: Decodable, Sendable {
    let id: String
}

private struct MembershipRow: Decodable, Sendable {
    let role: String
    let memberID: String
    let teams: TeamRow

    enum CodingKeys: String, CodingKey {
        case role
        case memberID = "member_id"
        case teams
    }
}

private struct TeamRow: Decodable, Sendable {
    let id: String
    let name: String
    let slug: String
}

private struct CreatedTeamRow: Decodable, Sendable {
    let teamID: String
    let teamName: String
    let teamSlug: String
    let memberID: String
    let role: String
    let workspaceID: String
    let workspaceName: String

    enum CodingKeys: String, CodingKey {
        case teamID = "team_id"
        case teamName = "team_name"
        case teamSlug = "team_slug"
        case memberID = "member_id"
        case role
        case workspaceID = "workspace_id"
        case workspaceName = "workspace_name"
    }
}

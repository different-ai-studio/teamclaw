import Foundation

/// Team-scoped runtime state — the bundle of repositories and observable
/// stores tied to the currently active team.
///
/// Built once per active-team transition by `AppOnboardingCoordinator`,
/// replaced atomically when the active team changes, nilled on sign-out.
/// Pass this into `RootTabView` instead of having the view construct
/// repositories itself; that keeps composition out of view bodies and
/// makes team switching a single observable change.
///
/// Repository slots are optional because their initializers can throw
/// (missing Supabase configuration). Callers that absolutely need a
/// repository should still guard for nil — Phase 1 preserves the
/// existing graceful-degradation behavior.
@MainActor
public struct TeamRuntimeContext {
    public let team: TeamSummary
    public let memberActorID: String

    public let actorStore: ActorStore
    public let connectedAgentsStore: ConnectedAgentsStore
    public let shortcutsStore: ShortcutsStore?
    public let notificationPrefsStore: NotificationPrefsStore?

    public let sessionIDsRepo: (any SessionIDsRepository)?
    public let sessionsRepo: (any SessionsRepository)?
    public let messagesRepo: (any MessagesRepository)?
    public let agentRuntimesRepo: (any AgentRuntimesRepository)?
    public let workspacesRepo: (any WorkspaceRepository)?
    public let agentAccessRepo: (any AgentAccessRepository)?
    public let teamRepo: (any TeamRepository)?
    public let sessionRepo: (any SessionRepository)?
    public let ideasRepo: (any IdeaRepository)?
    public let actorRepo: (any ActorRepository)?

    public init(
        team: TeamSummary,
        memberActorID: String,
        actorStore: ActorStore,
        connectedAgentsStore: ConnectedAgentsStore,
        shortcutsStore: ShortcutsStore?,
        notificationPrefsStore: NotificationPrefsStore? = nil,
        sessionIDsRepo: (any SessionIDsRepository)?,
        sessionsRepo: (any SessionsRepository)?,
        messagesRepo: (any MessagesRepository)?,
        agentRuntimesRepo: (any AgentRuntimesRepository)?,
        workspacesRepo: (any WorkspaceRepository)?,
        agentAccessRepo: (any AgentAccessRepository)?,
        teamRepo: (any TeamRepository)? = nil,
        sessionRepo: (any SessionRepository)? = nil,
        ideasRepo: (any IdeaRepository)? = nil,
        actorRepo: (any ActorRepository)? = nil
    ) {
        self.team = team
        self.memberActorID = memberActorID
        self.actorStore = actorStore
        self.connectedAgentsStore = connectedAgentsStore
        self.shortcutsStore = shortcutsStore
        self.notificationPrefsStore = notificationPrefsStore
        self.sessionIDsRepo = sessionIDsRepo
        self.sessionsRepo = sessionsRepo
        self.messagesRepo = messagesRepo
        self.agentRuntimesRepo = agentRuntimesRepo
        self.workspacesRepo = workspacesRepo
        self.agentAccessRepo = agentAccessRepo
        self.teamRepo = teamRepo
        self.sessionRepo = sessionRepo
        self.ideasRepo = ideasRepo
        self.actorRepo = actorRepo
    }
}

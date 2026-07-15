import SwiftUI
import SwiftData
import AMUXCore

public struct SearchTab: View {
    let mqtt: MQTTService
    let pairing: PairingManager
    let teamclawService: TeamclawService?
    @Bindable var viewModel: SessionListViewModel
    @Binding var rootSelection: AppTab
    @Binding var sessionsPath: [String]

    @Environment(\.modelContext) private var modelContext
    @State private var query: String = ""

    @Query(filter: #Predicate<SessionIdea> { !$0.archived })
    private var allIdeas: [SessionIdea]

    @Query(filter: #Predicate<CachedActor> { $0.actorType == "member" },
           sort: \CachedActor.displayName)
    private var allMembers: [CachedActor]

    public init(mqtt: MQTTService,
                pairing: PairingManager,
                teamclawService: TeamclawService?,
                viewModel: SessionListViewModel,
                rootSelection: Binding<AppTab>,
                sessionsPath: Binding<[String]>) {
        self.mqtt = mqtt
        self.pairing = pairing
        self.teamclawService = teamclawService
        self.viewModel = viewModel
        self._rootSelection = rootSelection
        self._sessionsPath = sessionsPath
    }

    private var sessionMatches: [Session] {
        viewModel.sessions.filter { session in
            let runtime = primaryRuntime(for: session)
            return SearchMatcher.matchesAny(
                fields: [
                    session.title,
                    session.lastMessagePreview,
                    runtime?.currentPrompt ?? "",
                    runtime?.lastOutputSummary ?? "",
                    runtime?.worktree ?? "",
                ],
                query: query
            )
        }
    }

    private var ideaMatches: [SessionIdea] {
        allIdeas.filter {
            SearchMatcher.matchesAny(
                fields: [$0.title, $0.ideaDescription],
                query: query
            )
        }
    }

    private var memberMatches: [CachedActor] {
        allMembers.filter {
            SearchMatcher.matches(haystack: $0.displayName, query: query)
        }
    }

    public var body: some View {
        NavigationStack {
            List {
                if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    ContentUnavailableView("Search",
                        systemImage: "magnifyingglass",
                        description: Text("Search sessions, ideas, and members."))
                } else {
                    if !sessionMatches.isEmpty {
                        Section("Sessions") {
                            ForEach(sessionMatches, id: \.sessionId) { session in
                                let runtime = primaryRuntime(for: session)
                                Button {
                                    rootSelection = .sessions
                                    sessionsPath.append("session:\(session.sessionId)")
                                } label: {
                                    AgentRowView(
                                        session: session,
                                        runtime: runtime,
                                        workspaceName: workspaceName(for: runtime)
                                    )
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    if !ideaMatches.isEmpty {
                        Section("Ideas") {
                            ForEach(ideaMatches, id: \.ideaId) { item in
                                IdeaRow(item: item)
                            }
                        }
                    }

                    if !memberMatches.isEmpty {
                        Section("Members") {
                            ForEach(memberMatches, id: \.actorId) { member in
                                HStack {
                                    Text(member.displayName)
                                        .font(.body)
                                    Spacer()
                                    Text(member.roleLabel)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }

                    if sessionMatches.isEmpty && ideaMatches.isEmpty && memberMatches.isEmpty {
                        ContentUnavailableView.search(text: query)
                    }
                }
            }
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.large)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always))
        }
    }

    private func primaryRuntime(for session: Session) -> Runtime? {
        guard let id = session.primaryAgentId, !id.isEmpty else { return nil }
        return viewModel.runtimes.first(where: { $0.runtimeId == id })
    }

    private func workspaceName(for runtime: Runtime?) -> String {
        guard let runtime else { return "" }
        return viewModel.workspaces.first(where: { $0.workspaceId == runtime.workspaceId })?.displayName ?? ""
    }
}

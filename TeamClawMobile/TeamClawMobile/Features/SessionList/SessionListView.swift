import SwiftUI
import SwiftData

// MARK: - SessionListView

struct SessionListView: View {
    let mqttService: MQTTServiceProtocol
    @ObservedObject var connectionMonitor: ConnectionMonitor
    @ObservedObject var pairingManager: PairingManager

    @Environment(\.modelContext) private var modelContext
    @StateObject private var viewModel: SessionListViewModel

    @State private var showFunctionPanel = false
    @State private var showMemberPanel = false
    @State private var navigationPath: [String] = []
    @State private var searchText = ""
    @State private var isSearchActive = false
    @FocusState private var searchFocused: Bool

    init(mqttService: MQTTServiceProtocol, connectionMonitor: ConnectionMonitor, pairingManager: PairingManager) {
        self.mqttService = mqttService
        self.connectionMonitor = connectionMonitor
        self.pairingManager = pairingManager
        // Use shared app container so data persists correctly
        let container = try! ModelContainer(for: Session.self, ChatMessage.self, TeamMember.self, AutomationTask.self, Skill.self)
        _viewModel = StateObject(wrappedValue: SessionListViewModel(
            modelContext: ModelContext(container),
            mqttService: mqttService
        ))
    }

    var body: some View {
        NavigationStack(path: $navigationPath) {
            VStack(spacing: 0) {
                if !connectionMonitor.isDesktopOnline {
                    HStack(spacing: 6) {
                        Image(systemName: "wifi.slash")
                            .font(.caption)
                        Text("桌面端离线")
                            .font(.caption)
                    }
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                    .background(Color.orange)
                }

                SessionListContent(
                    viewModel: viewModel,
                    navigationPath: $navigationPath
                )
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button {
                        showFunctionPanel = true
                    } label: {
                        Image(systemName: "line.3.horizontal")
                            .font(.title3)
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

                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        showMemberPanel = true
                    } label: {
                        Image(systemName: "person.2.fill")
                            .font(.title3)
                    }
                }
            }
            .navigationDestination(for: String.self) { sessionID in
                if let session = viewModel.sessions.first(where: { $0.id == sessionID }) {
                    ChatDetailView(session: session, mqttService: mqttService)
                } else {
                    Text("Session not found")
                }
            }
            .sheet(isPresented: $showFunctionPanel) {
                FunctionPanelView(
                    mqttService: mqttService,
                    pairingManager: pairingManager,
                    connectionMonitor: connectionMonitor
                )
            }
            .sheet(isPresented: $showMemberPanel) {
                MemberListView(
                    viewModel: MemberViewModel(
                        modelContext: modelContext,
                        mqttService: mqttService
                    ),
                    mqttService: mqttService
                )
            }
            .safeAreaInset(edge: .bottom) {
                iMessageBar
            }
            .onChange(of: searchText) {
                viewModel.searchText = searchText
                viewModel.applySearch()
            }
            .onAppear {
                viewModel.loadSessions()
            }
        }
    }

    // MARK: - iMessage-style Bottom Bar

    private var iMessageBar: some View {
        HStack(spacing: 10) {
            // Search capsule
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                if isSearchActive {
                    TextField("搜索", text: $searchText)
                        .focused($searchFocused)
                } else {
                    Text("搜索")
                        .foregroundStyle(.secondary)
                    Spacer()
                }
            }
            .padding(.horizontal, 16)
            .frame(height: 44)
            .modifier(GlassCapsuleModifier())
            .contentShape(Capsule())
            .onTapGesture {
                withAnimation {
                    isSearchActive = true
                }
                searchFocused = true
            }

            // Right button: compose or dismiss
            if isSearchActive {
                Button {
                    withAnimation {
                        searchText = ""
                        isSearchActive = false
                        searchFocused = false
                    }
                } label: {
                    Image(systemName: "xmark")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 44, height: 44)
                }
                .modifier(GlassCircleModifier())
                .transition(.scale.combined(with: .opacity))
            } else {
                Button {
                    let newSession = viewModel.createSession()
                    navigationPath.append(newSession.id)
                } label: {
                    Image(systemName: "square.and.pencil")
                        .font(.body.weight(.medium))
                        .foregroundStyle(.secondary)
                        .frame(width: 44, height: 44)
                }
                .modifier(GlassCircleModifier())
                .transition(.scale.combined(with: .opacity))
            }
        }
        .animation(.default, value: isSearchActive)
        .padding(.horizontal, 16)
    }
}

// MARK: - Glass Modifiers

private struct GlassCapsuleModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background {
                Capsule()
                    .fill(.gray.opacity(0.14))
                    .background(.ultraThinMaterial, in: Capsule())
            }
            .shadow(color: .black.opacity(0.08), radius: 10, y: 3)
    }
}

private struct GlassCircleModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background {
                Circle()
                    .fill(.gray.opacity(0.14))
                    .background(.ultraThinMaterial, in: Circle())
            }
            .shadow(color: .black.opacity(0.08), radius: 10, y: 3)
    }
}

// MARK: - SessionListContent

private struct SessionListContent: View {
    @ObservedObject var viewModel: SessionListViewModel
    @Binding var navigationPath: [String]

    var body: some View {
        Group {
            if viewModel.filteredSessions.isEmpty && viewModel.isLoading {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("加载会话列表...")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    ForEach(viewModel.filteredSessions, id: \.id) { session in
                        SessionRowView(session: session, relativeTime: viewModel.relativeTime(for: session.lastMessageTime))
                            .contentShape(Rectangle())
                            .onTapGesture {
                                navigationPath.append(session.id)
                            }
                            .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                    }
                    .onDelete { offsets in
                        for index in offsets {
                            let session = viewModel.filteredSessions[index]
                            viewModel.deleteSession(session)
                        }
                    }
                }
                .listStyle(.plain)
                .refreshable {
                    viewModel.requestSessions()
                }
            }
        }
    }
}

// MARK: - SessionRowView

struct SessionRowView: View {
    let session: Session
    let relativeTime: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            // Agent avatar circle
            ZStack {
                Circle()
                    .fill(Color.accentColor.opacity(0.15))
                    .frame(width: 48, height: 48)
                Text(String(session.agentName.prefix(1)))
                    .font(.title3.bold())
                    .foregroundStyle(Color.accentColor)
            }

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 4) {
                    Text(session.title)
                        .font(.headline)
                        .lineLimit(1)
                    if session.isCollaborative {
                        Image(systemName: "person.2.fill")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Text(session.lastMessageContent)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            Text(relativeTime)
                .font(.caption)
                .foregroundStyle(.tertiary)
                .padding(.top, 2)
        }
        .padding(.vertical, 10)
    }
}

// MARK: - Preview

#Preview {
    let config = ModelConfiguration(isStoredInMemoryOnly: true)
    let container = try! ModelContainer(for: Session.self, configurations: config)
    let context = container.mainContext

    let s1 = Session(
        id: "1",
        title: "运营搭档",
        agentName: "运营",
        lastMessageContent: "帮你整理了日报...",
        lastMessageTime: Date().addingTimeInterval(-120),
        isCollaborative: false
    )
    let s2 = Session(
        id: "2",
        title: "代码搭档",
        agentName: "代码",
        lastMessageContent: "张三: 方案可以...",
        lastMessageTime: Date().addingTimeInterval(-3600),
        isCollaborative: true,
        collaboratorIDs: ["user-1", "user-2"]
    )
    context.insert(s1)
    context.insert(s2)

    let mockMQTT = MockMQTTService()
    let monitor = ConnectionMonitor(mqttService: mockMQTT)

    return SessionListView(mqttService: mockMQTT, connectionMonitor: monitor, pairingManager: PairingManager())
        .modelContainer(container)
}

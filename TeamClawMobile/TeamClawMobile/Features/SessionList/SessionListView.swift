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
    @State private var showNewSession = false
    @State private var navigationPath: [String] = []
    @State private var searchText = ""
    @FocusState private var isSearchFocused: Bool

    init(mqttService: MQTTServiceProtocol, connectionMonitor: ConnectionMonitor, pairingManager: PairingManager) {
        self.mqttService = mqttService
        self.connectionMonitor = connectionMonitor
        self.pairingManager = pairingManager
        _viewModel = StateObject(wrappedValue: SessionListViewModel(mqttService: mqttService))
    }

    private var workspaceTitle: String {
        if let name = pairingManager.pairedDeviceName, !name.isEmpty {
            return "\(name) Sessions"
        }
        return "Sessions"
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
                        Image(systemName: "square.grid.2x2")
                            .font(.title3)
                    }
                }

                ToolbarItem(placement: .principal) {
                    VStack(spacing: 1) {
                        Text(workspaceTitle)
                            .font(.headline)
                            .lineLimit(1)
                        Text("\(viewModel.filteredSessions.count) 个会话")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }

                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        showMemberPanel = true
                    } label: {
                        Image(systemName: "person.2.fill")
                            .font(.subheadline)
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
                    viewModel: MemberViewModel(mqttService: mqttService),
                    mqttService: mqttService
                )
            }
            .sheet(isPresented: $showNewSession) {
                NewSessionSheet { newSession in
                    viewModel.sessions.insert(newSession, at: 0)
                    viewModel.applySearch()
                    navigationPath.append(newSession.id)
                }
            }
            .safeAreaInset(edge: .bottom) {
                LiquidGlassContainer(spacing: 8) {
                    HStack(spacing: 8) {
                        HStack(spacing: 6) {
                            Image(systemName: "magnifyingglass")
                                .foregroundStyle(.secondary)
                                .font(.subheadline)
                            TextField("搜索", text: $searchText)
                                .font(.body)
                                .focused($isSearchFocused)
                                .onChange(of: searchText) {
                                    viewModel.searchText = searchText
                                    viewModel.applySearch()
                                }
                            if !searchText.isEmpty {
                                Button {
                                    searchText = ""
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .liquidGlass(in: Capsule(), interactive: false)

                        if isSearchFocused {
                            Button {
                                searchText = ""
                                isSearchFocused = false
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.title3)
                                    .padding(10)
                            }
                            .liquidGlass(in: Circle())
                            .transition(.scale.combined(with: .opacity))
                        } else {
                            Button {
                                showNewSession = true
                            } label: {
                                Image(systemName: "square.and.pencil")
                                    .font(.title3)
                                    .padding(10)
                            }
                            .liquidGlass(in: Circle())
                            .transition(.scale.combined(with: .opacity))
                        }
                    }
                    .animation(.spring(duration: 0.25), value: isSearchFocused)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
                }
            }
            .onAppear {
                viewModel.setModelContext(modelContext)
                viewModel.loadSessions()
            }
        }
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
                    ForEach(viewModel.groupedFilteredSessions) { group in
                        Section(header: Text(group.title).font(.headline).foregroundStyle(.primary)) {
                            ForEach(group.sessions, id: \.id) { session in
                                SessionRowView(
                                    session: session,
                                    relativeTime: viewModel.relativeTime(for: session.lastMessageTime)
                                )
                                .contentShape(Rectangle())
                                .onTapGesture {
                                    navigationPath.append(session.id)
                                }
                                .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                            }
                            .onDelete { offsets in
                                for index in offsets {
                                    viewModel.deleteSession(group.sessions[index])
                                }
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
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
        HStack(alignment: .center, spacing: 12) {
            // Left: 3-line text block
            VStack(alignment: .leading, spacing: 2) {
                // Line 1: title
                Text(session.title.isEmpty ? "新会话" : session.title)
                    .font(.body)
                    .fontWeight(.semibold)
                    .lineLimit(1)
                    .foregroundStyle(.primary)

                // Line 2: last message placeholder
                Text(session.lastMessageContent.isEmpty ? "—" : session.lastMessageContent)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)

                // Line 3: summary + status + relative time
                HStack(spacing: 6) {
                    if session.summaryFiles > 0 {
                        Text("+\(session.summaryAdditions) -\(session.summaryDeletions) · \(session.summaryFiles) 文件")
                            .foregroundStyle(.secondary)
                    }
                    if let status = session.status, !status.isEmpty {
                        SessionStatusBadge(status: status)
                    }
                    Spacer(minLength: 0)
                    Text(relativeTime)
                        .foregroundStyle(.tertiary)
                }
                .font(.caption)
            }

            Spacer(minLength: 0)

            // Right: rounded-square avatar (Apple Notes style)
            SessionAvatar(name: session.agentName, isCollaborative: session.isCollaborative)
        }
        .padding(.vertical, 10)
    }
}

// MARK: - SessionAvatar

private struct SessionAvatar: View {
    let name: String
    let isCollaborative: Bool

    private var avatarColor: Color {
        let colors: [Color] = [.blue, .purple, .orange, .green, .pink, .teal, .indigo]
        let index = abs(name.hashValue) % colors.count
        return colors[index]
    }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 10)
                .fill(avatarColor.opacity(0.18))
                .frame(width: 48, height: 48)
            if isCollaborative {
                Image(systemName: "person.2.fill")
                    .font(.title3)
                    .foregroundStyle(avatarColor)
            } else {
                Text(String((name.isEmpty ? "A" : name).prefix(1)))
                    .font(.title3.bold())
                    .foregroundStyle(avatarColor)
            }
        }
    }
}

// MARK: - SessionStatusBadge

private struct SessionStatusBadge: View {
    let status: String

    private var color: Color {
        switch status.lowercased() {
        case "running", "active": return .blue
        case "completed", "done": return .green
        case "error", "failed": return .red
        default: return .secondary
        }
    }

    var body: some View {
        Text(status)
            .font(.caption2)
            .fontWeight(.medium)
            .foregroundStyle(color)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(color.opacity(0.12), in: Capsule())
    }
}

// MARK: - Preview

#Preview {
    let config = ModelConfiguration(isStoredInMemoryOnly: true)
    let container = try! ModelContainer(for: Session.self, configurations: config)
    let context = container.mainContext

    let now = Date()
    let s1 = Session(id: "1", title: "运营搭档", agentName: "运营",
                     lastMessageContent: "", lastMessageTime: now.addingTimeInterval(-120),
                     status: "running", summaryAdditions: 12, summaryDeletions: 3, summaryFiles: 2)
    let s2 = Session(id: "2", title: "代码搭档", agentName: "代码",
                     lastMessageContent: "", lastMessageTime: now.addingTimeInterval(-86400 * 2),
                     isCollaborative: true, status: "completed", summaryFiles: 5)
    let s3 = Session(id: "3", title: "成本上限", agentName: "财务",
                     lastMessageContent: "", lastMessageTime: now.addingTimeInterval(-86400 * 20))
    let s4 = Session(id: "4", title: "Q1 复盘", agentName: "策略",
                     lastMessageContent: "", lastMessageTime: now.addingTimeInterval(-86400 * 60))
    [s1, s2, s3, s4].forEach { context.insert($0) }

    let mockMQTT = MockMQTTService()
    let monitor = ConnectionMonitor(mqttService: mockMQTT)
    let pairing = PairingManager()

    return SessionListView(mqttService: mockMQTT, connectionMonitor: monitor, pairingManager: pairing)
        .modelContainer(container)
}

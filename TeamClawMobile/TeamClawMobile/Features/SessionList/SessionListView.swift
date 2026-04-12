import SwiftUI
import SwiftData

// MARK: - SessionListView

struct SessionListView: View {
    let mqttService: MQTTServiceProtocol
    @ObservedObject var connectionMonitor: ConnectionMonitor
    @ObservedObject var pairingManager: PairingManager

    @Environment(\.modelContext) private var modelContext
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var viewModel: SessionListViewModel

    @State private var showFunctionPanel = false
    @State private var showMemberPanel = false
    @State private var showNewSession = false
    @State private var navigationPath: [String] = []
    @State private var searchText = ""
    @FocusState private var isSearchFocused: Bool

    // Edit mode
    @State private var isEditing = false
    @State private var selectedIDs: Set<String> = []

    // Rename
    @State private var renamingSession: Session?
    @State private var renameText = ""

    // Add member
    @State private var addMemberSession: Session?

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
                    navigationPath: $navigationPath,
                    isEditing: $isEditing,
                    selectedIDs: $selectedIDs,
                    renamingSession: $renamingSession,
                    renameText: $renameText,
                    addMemberSession: $addMemberSession
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
                            .foregroundStyle(.primary)
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
                        withAnimation(.spring(duration: 0.25)) {
                            isEditing.toggle()
                            if !isEditing { selectedIDs.removeAll() }
                        }
                    } label: {
                        Text(isEditing ? "完成" : "选择")
                    }
                }

                if !isEditing {
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button {
                            showMemberPanel = true
                        } label: {
                            Image(systemName: "person.2.fill")
                        }
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
                UnifiedMemberSheet(mode: .browse, mqttService: mqttService)
            }
            .sheet(isPresented: $showNewSession) {
                NewSessionSheet(mqttService: mqttService) { newSession in
                    viewModel.sessions.insert(newSession, at: 0)
                    viewModel.applySearch()
                    navigationPath.append(newSession.id)
                }
            }
            .sheet(item: $addMemberSession) { session in
                UnifiedMemberSheet(
                    mode: .select(
                        preSelected: Set(session.collaboratorIDs),
                        onConfirm: { ids in
                            session.collaboratorIDs = Array(ids)
                            session.isCollaborative = !ids.isEmpty
                            try? modelContext.save()
                        }
                    ),
                    mqttService: mqttService
                )
            }
            .alert("重命名会话", isPresented: Binding(
                get: { renamingSession != nil },
                set: { if !$0 { renamingSession = nil } }
            )) {
                TextField("会话标题", text: $renameText)
                Button("取消", role: .cancel) { renamingSession = nil }
                Button("确定") {
                    if let session = renamingSession {
                        viewModel.renameSession(session, to: renameText)
                    }
                    renamingSession = nil
                }
            }
            .safeAreaInset(edge: .bottom) {
                if isEditing {
                    editToolbar
                } else {
                    searchBar
                }
            }
            .onAppear {
                viewModel.setModelContext(modelContext)
                viewModel.loadSessions()
            }
            .onChange(of: scenePhase) { _, newPhase in
                if newPhase == .active {
                    viewModel.refreshIfStale()
                }
            }
        }
    }

    // MARK: - Search Bar

    private var searchBar: some View {
        LiquidGlassContainer(spacing: 8) {
            HStack(spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.secondary)
                        .font(.body)
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
                                .font(.body)
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .liquidGlass(in: Capsule(), interactive: false)

                if isSearchFocused {
                    Button {
                        searchText = ""
                        isSearchFocused = false
                    } label: {
                        Image(systemName: "xmark")
                            .font(.title2)
                            .foregroundStyle(.primary)
                            .frame(width: 48, height: 48)
                    }
                    .liquidGlass(in: Circle())
                    .transition(.scale.combined(with: .opacity))
                } else {
                    Button {
                        showNewSession = true
                    } label: {
                        Image(systemName: "square.and.pencil")
                            .font(.title2)
                            .foregroundStyle(.primary)
                            .frame(width: 48, height: 48)
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

    // MARK: - Edit Toolbar

    private var editToolbar: some View {
        LiquidGlassContainer(spacing: 8) {
            HStack(spacing: 8) {
                Button {
                    viewModel.archiveSessions(ids: selectedIDs)
                    selectedIDs.removeAll()
                    isEditing = false
                } label: {
                    VStack(spacing: 4) {
                        Image(systemName: "archivebox")
                            .font(.title3)
                        Text("归档")
                            .font(.caption2)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                }
                .disabled(selectedIDs.isEmpty)
                .liquidGlass(in: RoundedRectangle(cornerRadius: 16))

                Button {
                    viewModel.togglePinSessions(ids: selectedIDs)
                    selectedIDs.removeAll()
                    isEditing = false
                } label: {
                    let allPinned = selectedIDs.allSatisfy { id in
                        viewModel.sessions.first(where: { $0.id == id })?.isPinned == true
                    }
                    VStack(spacing: 4) {
                        Image(systemName: allPinned ? "pin.slash" : "pin")
                            .font(.title3)
                        Text(allPinned ? "取消置顶" : "置顶")
                            .font(.caption2)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                }
                .disabled(selectedIDs.isEmpty)
                .liquidGlass(in: RoundedRectangle(cornerRadius: 16))

                Button {
                    addMemberSession = viewModel.sessions.first(where: { selectedIDs.contains($0.id) })
                } label: {
                    VStack(spacing: 4) {
                        Image(systemName: "person.badge.plus")
                            .font(.title3)
                        Text("添加成员")
                            .font(.caption2)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                }
                .disabled(selectedIDs.isEmpty)
                .liquidGlass(in: RoundedRectangle(cornerRadius: 16))
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
        }
    }
}

// MARK: - SessionListContent

private struct SessionListContent: View {
    @ObservedObject var viewModel: SessionListViewModel
    @Binding var navigationPath: [String]
    @Binding var isEditing: Bool
    @Binding var selectedIDs: Set<String>
    @Binding var renamingSession: Session?
    @Binding var renameText: String
    @Binding var addMemberSession: Session?

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
                                sessionRow(session)
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

    @ViewBuilder
    private func sessionRow(_ session: Session) -> some View {
        HStack(spacing: 10) {
            if isEditing {
                Image(systemName: selectedIDs.contains(session.id) ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selectedIDs.contains(session.id) ? .blue : .secondary)
                    .font(.title3)
                    .onTapGesture {
                        if selectedIDs.contains(session.id) {
                            selectedIDs.remove(session.id)
                        } else {
                            selectedIDs.insert(session.id)
                        }
                    }
            }

            SessionRowView(
                session: session,
                relativeTime: viewModel.relativeTime(for: session.lastMessageTime)
            )
        }
        .contentShape(Rectangle())
        .onTapGesture {
            if isEditing {
                if selectedIDs.contains(session.id) {
                    selectedIDs.remove(session.id)
                } else {
                    selectedIDs.insert(session.id)
                }
            } else {
                navigationPath.append(session.id)
            }
        }
        .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button {
                viewModel.togglePin(session)
            } label: {
                Label(session.isPinned ? "取消置顶" : "置顶",
                      systemImage: session.isPinned ? "pin.slash" : "pin")
            }
            .tint(.yellow)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button {
                viewModel.archiveSession(session)
            } label: {
                Label("归档", systemImage: "archivebox")
            }
            .tint(.purple)
        }
        .contextMenu {
            Button {
                renameText = session.title
                renamingSession = session
            } label: {
                Label("修改标题", systemImage: "pencil")
            }

            Button {
                addMemberSession = session
            } label: {
                Label("添加成员", systemImage: "person.badge.plus")
            }

            Divider()

            Button {
                viewModel.togglePin(session)
            } label: {
                Label(session.isPinned ? "取消置顶" : "置顶",
                      systemImage: session.isPinned ? "pin.slash" : "pin")
            }

            Button {
                viewModel.archiveSession(session)
            } label: {
                Label("归档", systemImage: "archivebox")
            }

            Divider()

            Button(role: .destructive) {
                viewModel.deleteSession(session)
            } label: {
                Label("删除", systemImage: "trash")
            }
        }
    }
}

// MARK: - SessionRowView

struct SessionRowView: View {
    let session: Session
    let relativeTime: String

    private var isActive: Bool {
        guard let status = session.status else { return false }
        let s = status.lowercased()
        return s == "running" || s == "active"
    }

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            // Blue dot for active status
            Circle()
                .fill(isActive ? Color.blue : Color.clear)
                .frame(width: 10, height: 10)

            VStack(alignment: .leading, spacing: 3) {
                // Line 1: title + pin icon + time
                HStack {
                    if session.isPinned {
                        Image(systemName: "pin.fill")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                    }
                    Text(session.title.isEmpty ? "新会话" : session.title)
                        .font(.body)
                        .fontWeight(.semibold)
                        .lineLimit(1)
                        .foregroundStyle(.primary)

                    Spacer(minLength: 0)

                    Text(relativeTime)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }

                // Line 2: last message preview
                Text(session.lastMessageContent.isEmpty ? "—" : session.lastMessageContent)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 10)
    }
}

// MARK: - Preview

#Preview {
    let config = ModelConfiguration(isStoredInMemoryOnly: true)
    let container = try! ModelContainer(for: Session.self, TeamMember.self, configurations: config)
    let context = container.mainContext

    let now = Date()
    let s1 = Session(id: "1", title: "运营搭档", agentName: "运营",
                     lastMessageContent: "", lastMessageTime: now.addingTimeInterval(-120),
                     status: "running", summaryAdditions: 12, summaryDeletions: 3, summaryFiles: 2)
    let s2 = Session(id: "2", title: "代码搭档", agentName: "代码",
                     lastMessageContent: "", lastMessageTime: now.addingTimeInterval(-86400 * 2),
                     isCollaborative: true, status: "completed", summaryFiles: 5)
    let s3 = Session(id: "3", title: "成本上限", agentName: "财务",
                     lastMessageContent: "", lastMessageTime: now.addingTimeInterval(-86400 * 20),
                     isPinned: true)
    let s4 = Session(id: "4", title: "Q1 复盘", agentName: "策略",
                     lastMessageContent: "", lastMessageTime: now.addingTimeInterval(-86400 * 60))
    [s1, s2, s3, s4].forEach { context.insert($0) }

    let mockMQTT = MockMQTTService()
    let monitor = ConnectionMonitor(mqttService: mockMQTT)
    let pairing = PairingManager()

    return SessionListView(mqttService: mockMQTT, connectionMonitor: monitor, pairingManager: pairing)
        .modelContainer(container)
}

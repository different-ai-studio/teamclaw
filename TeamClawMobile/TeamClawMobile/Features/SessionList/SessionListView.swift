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
    @State private var showSearch = false
    @State private var navigationPath: [String] = []

    init(mqttService: MQTTServiceProtocol, connectionMonitor: ConnectionMonitor, pairingManager: PairingManager) {
        self.mqttService = mqttService
        self.connectionMonitor = connectionMonitor
        self.pairingManager = pairingManager
        // Temporary context placeholder; real context injected via onAppear
        _viewModel = StateObject(wrappedValue: SessionListViewModel(
            modelContext: ModelContext(try! ModelContainer(for: Session.self)),
            mqttService: mqttService
        ))
    }

    var body: some View {
        NavigationStack(path: $navigationPath) {
            ZStack(alignment: .bottom) {
                sessionList

                VStack(spacing: 0) {
                    Spacer()
                    bottomBar
                }
                .ignoresSafeArea(edges: .bottom)
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
                MemberListView(viewModel: MemberViewModel(
                    modelContext: modelContext,
                    mqttService: mqttService
                ))
            }
            .sheet(isPresented: $showSearch) {
                searchSheet
            }
            .onAppear {
                viewModel.loadSessions()
            }
        }
    }

    // MARK: - Session List

    @ViewBuilder
    private var sessionList: some View {
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

            // Bottom padding so last row isn't hidden behind the floating bar
            Color.clear
                .frame(height: 80)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets())
        }
        .listStyle(.plain)
    }

    // MARK: - Bottom Bar

    private var bottomBar: some View {
        LiquidGlassBar {
            HStack {
                Button {
                    showSearch = true
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "magnifyingglass")
                        Text("搜索")
                    }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)

                Divider()
                    .frame(height: 20)

                Button {
                    // New session: navigate to a new session placeholder
                    navigationPath.append("new-session-\(UUID().uuidString)")
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "plus.circle.fill")
                            .foregroundStyle(.blue)
                        Text("新建")
                            .foregroundStyle(.primary)
                    }
                    .font(.subheadline)
                }
                .frame(maxWidth: .infinity)
            }
        }
        .padding(.bottom, 20)
    }

    // MARK: - Search Sheet

    private var searchSheet: some View {
        NavigationStack {
            VStack(spacing: 0) {
                TextField("搜索会话...", text: $viewModel.searchText)
                    .textFieldStyle(.roundedBorder)
                    .padding()
                    .onChange(of: viewModel.searchText) {
                        viewModel.applySearch()
                    }

                List(viewModel.filteredSessions, id: \.id) { session in
                    SessionRowView(
                        session: session,
                        relativeTime: viewModel.relativeTime(for: session.lastMessageTime)
                    )
                    .contentShape(Rectangle())
                    .onTapGesture {
                        showSearch = false
                        navigationPath.append(session.id)
                    }
                }
                .listStyle(.plain)
            }
            .navigationTitle("搜索")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("取消") {
                        viewModel.searchText = ""
                        viewModel.applySearch()
                        showSearch = false
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
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

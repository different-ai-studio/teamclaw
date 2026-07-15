import SwiftUI
import AMUXCore

public struct SessionMemberSheet: View {
    public struct HumanRow: Identifiable, Equatable {
        public let id: String
        public let displayName: String
        public let isOnline: Bool
        public let canRemove: Bool
    }
    public struct AgentRow: Identifiable, Equatable {
        public let id: String                 // agent_id
        public let displayName: String
        public let workspacePath: String
        public let agentType: String          // "Claude" / "OpenCode" / "Codex"
        public let runtimeState: AgentChipBar.RuntimeChipState
        public let availableModels: [String]
        public let currentModel: String?
    }

    let humans: [HumanRow]
    let agents: [AgentRow]
    let onRemoveHuman: (String) -> Void
    let onRestartRuntime: (String) -> Void
    let onChangeModel: (String, String) -> Void
    let onRemoveAgent: (String) -> Void
    let onAddAgent: () -> Void
    let onAddMember: () -> Void

    public init(humans: [HumanRow], agents: [AgentRow],
                onRemoveHuman: @escaping (String) -> Void,
                onRestartRuntime: @escaping (String) -> Void,
                onChangeModel: @escaping (String, String) -> Void,
                onRemoveAgent: @escaping (String) -> Void,
                onAddAgent: @escaping () -> Void,
                onAddMember: @escaping () -> Void) {
        self.humans = humans; self.agents = agents
        self.onRemoveHuman = onRemoveHuman
        self.onRestartRuntime = onRestartRuntime
        self.onChangeModel = onChangeModel
        self.onRemoveAgent = onRemoveAgent
        self.onAddAgent = onAddAgent; self.onAddMember = onAddMember
    }

    public var body: some View {
        NavigationStack {
            List {
                Section("Members") {
                    ForEach(humans) { h in
                        HStack {
                            Circle().fill(h.isOnline ? Color.amux.sage : Color.amux.slate).frame(width: 8, height: 8)
                            Text(h.displayName)
                            Spacer()
                            if h.canRemove {
                                Button(role: .destructive) { onRemoveHuman(h.id) } label: {
                                    Image(systemName: "xmark.circle")
                                }
                            }
                        }
                    }
                }
                Section("Agents") {
                    ForEach(agents) { a in
                        AgentMemberRow(
                            row: a,
                            onRestart: { onRestartRuntime(a.id) },
                            onChangeModel: { m in onChangeModel(a.id, m) },
                            onRemove: { onRemoveAgent(a.id) }
                        )
                    }
                }
            }
            .navigationTitle("Actors")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 8) {
                        topAddButton(systemImage: "person.badge.plus", action: onAddMember)
                            .accessibilityLabel("Add member")
                        topAddButton(systemImage: "sparkles", action: onAddAgent)
                            .accessibilityLabel("Add agent")
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    @ViewBuilder
    private func topAddButton(systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.title3)
                .foregroundStyle(Color.amux.cinnabar)
        }
        .buttonStyle(.plain)
    }
}

private struct AgentMemberRow: View {
    let row: SessionMemberSheet.AgentRow
    let onRestart: () -> Void
    let onChangeModel: (String) -> Void
    let onRemove: () -> Void

    /// Whether tapping the row should open the model picker. Requires a
    /// non-empty availableModels list in all states — an empty list means we
    /// have no runtime row and no fallback type, so the menu would open blank.
    /// stopped/error stay disabled (no live ACP to talk to).
    private var isInteractive: Bool {
        guard !row.availableModels.isEmpty else { return false }
        switch row.runtimeState {
        case .ready, .idle, .active, .spawning: return true
        case .stopped, .error: return false
        }
    }

    var body: some View {
        rowContent
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button(role: .destructive) { onRemove() } label: { Label("Remove", systemImage: "xmark") }
                Button { onRestart() } label: { Label("Restart", systemImage: "arrow.clockwise") }
                    .tint(.orange)
            }
    }

    // Putting the Menu on the trailing area (vs wrapping the entire row)
    // avoids gesture conflicts with the List's row tap/swipe handling —
    // the previous full-row Menu wrapper just no-op'd on tap.
    private var rowContent: some View {
        HStack(spacing: 8) {
            Circle().fill(row.runtimeState.color).frame(width: 8, height: 8)
            Text(row.displayName).fontWeight(.semibold).foregroundStyle(.primary)
            Text(row.agentType).foregroundStyle(.secondary).font(.caption)
            Spacer(minLength: 8)
            if isInteractive {
                Menu {
                    ForEach(row.availableModels, id: \.self) { m in
                        Button(m) { onChangeModel(m) }
                    }
                } label: {
                    HStack(spacing: 4) {
                        trailingLabel
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            } else {
                trailingLabel
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var trailingLabel: some View {
        // Daemon writes `current_model` into the initial agent_runtimes
        // upsert (manager.rs awaits initial_model_rx before the row
        // write) — so the model is known well before Supabase status
        // flips off "starting". Show it whenever we have it; the chip
        // dot color already communicates the spawning state. Only fall
        // through to spinner / "default" when we genuinely have no
        // model id yet (very early window, or MQTT-only path that hasn't
        // surfaced currentModel yet).
        if let model = row.currentModel, !model.isEmpty {
            Text(model)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        } else if row.runtimeState == .spawning {
            ProgressView()
                .controlSize(.small)
        } else {
            Text("default")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }
}

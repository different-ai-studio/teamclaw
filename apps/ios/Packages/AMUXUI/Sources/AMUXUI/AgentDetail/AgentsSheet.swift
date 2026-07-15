import SwiftUI
import AMUXCore

// MARK: - AgentsSheet

/// Sheet presented from the composer's [@] button. Shows all agents
/// participating in the current session, lets the user toggle which agents
/// receive the next send, and surfaces per-agent model pickers and interrupt
/// controls.
///
/// `AgentsSheetSubtitleFormatter` (pure, in AMUXCore) drives the section
/// header so the formatting logic stays unit-testable.
struct AgentsSheet: View {
    @Environment(\.dismiss) private var dismiss

    /// All agents in the current session.
    let agents: [MemberSheetAgent]
    /// Which agent IDs are currently selected to receive the next send.
    @Binding var selection: Set<String>
    /// Agent IDs that have an in-flight streaming reply.
    let streamingAgentIDs: Set<String>
    /// Resolves the live `Runtime` SwiftData object for a given agent.
    /// Kept as a closure so the sheet itself doesn't hold a SwiftData query.
    let runtimeForAgent: (MemberSheetAgent) -> Runtime?
    /// Called when the user picks a different model for an agent.
    let onApplyModel: (MemberSheetAgent, String) -> Void
    /// Called when the user confirms they want to interrupt an agent's reply.
    let onInterrupt: (MemberSheetAgent) -> Void

    @State private var pendingTerminate: MemberSheetAgent?

    var body: some View {
        NavigationStack {
            List {
                Section(header: header) {
                    if agents.isEmpty {
                        emptyState
                    } else {
                        ForEach(agents) { agent in
                            agentRow(for: agent)
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.amux.mist)
            .navigationTitle("Agents")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(Color.amux.cinnabar)
                }
            }
            .alert(
                "Stop agent?",
                isPresented: Binding(
                    get: { pendingTerminate != nil },
                    set: { if !$0 { pendingTerminate = nil } }
                ),
                presenting: pendingTerminate
            ) { agent in
                Button("Cancel", role: .cancel) {}
                Button("Stop", role: .destructive) {
                    onInterrupt(agent)
                }
            } message: { agent in
                Text("\"\(agent.displayName)\" is currently responding. Stopping will interrupt the reply mid-stream.")
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    // MARK: - Subviews

    private var header: some View {
        Text(AgentsSheetSubtitleFormatter.string(
            selected: selection.count,
            total: agents.count
        ))
        .font(.footnote)
        .foregroundStyle(.secondary)
    }

    private var emptyState: some View {
        Text("No agents in this session yet. Add one from session settings.")
            .font(.callout)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
            .listRowBackground(Color.clear)
    }

    @ViewBuilder
    private func agentRow(for agent: MemberSheetAgent) -> some View {
        let isSelected = selection.contains(agent.id)
        let isRunning = streamingAgentIDs.contains(agent.id)
        let runtime = runtimeForAgent(agent)

        HStack(spacing: 12) {
            // Selection indicator
            Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(isSelected ? Color.amux.cinnabar : .secondary)
                .accessibilityHidden(true)

            // Agent name
            Text(agent.displayName)
                .lineLimit(1)

            Spacer()

            // Model picker — available when the runtime has model options
            if let runtime, !runtime.availableModels.isEmpty {
                Menu {
                    ForEach(runtime.availableModels) { model in
                        Button {
                            onApplyModel(agent, model.id)
                        } label: {
                            HStack {
                                Text(model.displayName)
                                if model.id == runtime.currentModel {
                                    Spacer()
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 2) {
                        Text(currentModelLabel(runtime))
                            .font(.caption)
                        Image(systemName: "chevron.down")
                            .font(.caption2)
                    }
                    .foregroundStyle(.secondary)
                }
            }

            // Running / idle indicator + interrupt button
            if isRunning {
                HStack(spacing: 4) {
                    Circle()
                        .fill(Color.amux.sage)
                        .frame(width: 6, height: 6)
                    Text("Running")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Button {
                    pendingTerminate = agent
                } label: {
                    Image(systemName: "stop.fill")
                        .foregroundStyle(Color.amux.cinnabarDeep)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Stop \(agent.displayName)")
                .accessibilityHint("Stops this agent's current reply")
            } else {
                Text("idle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .onTapGesture {
            toggleSelection(agent)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel(agent: agent, isSelected: isSelected, isRunning: isRunning))
    }

    // MARK: - Helpers

    private func currentModelLabel(_ runtime: Runtime) -> String {
        guard let currentID = runtime.currentModel, !currentID.isEmpty else {
            return "Model"
        }
        return runtime.availableModels.first(where: { $0.id == currentID })?.displayName ?? currentID
    }

    private func toggleSelection(_ agent: MemberSheetAgent) {
        if selection.contains(agent.id) {
            selection.remove(agent.id)
        } else {
            selection.insert(agent.id)
        }
    }

    private func accessibilityLabel(agent: MemberSheetAgent, isSelected: Bool, isRunning: Bool) -> String {
        var parts = [agent.displayName]
        parts.append(isSelected ? "selected" : "unselected")
        parts.append(isRunning ? "running" : "idle")
        return parts.joined(separator: ", ")
    }
}

import SwiftUI
import AMUXCore

/// Strip of chips above the composer showing which agents are engaged
/// for the next message. Two states per chip:
///
/// - **idle** (runtime not currently streaming): the chip carries an
///   `×` button that removes the agent from the routing set. The
///   message body simply won't be addressed to that agent.
///
/// - **streaming** (runtime currently producing output): the `×` is
///   replaced by a stop button. Tapping it surfaces a confirm alert;
///   confirming calls `onInterrupt(agentID)` so the parent can ACP-
///   cancel that specific runtime — a per-agent kill switch that
///   replaces the old composer-level "stop" affordance, which would
///   have stopped a single bound runtime even in a multi-agent
///   session.
public struct AgentChipBar: View {
    public struct AgentChip: Identifiable, Equatable {
        public let id: String           // agent_id
        public let displayName: String
        public let runtimeState: RuntimeChipState
        public init(id: String, displayName: String, runtimeState: RuntimeChipState) {
            self.id = id; self.displayName = displayName; self.runtimeState = runtimeState
        }
    }

    public enum RuntimeChipState: Equatable {
        case spawning, ready, idle, active, stopped, error
        var color: Color {
            switch self {
            case .spawning: return .gray
            case .ready, .idle: return Color.amux.sage
            case .active: return .yellow
            case .stopped: return Color.amux.slate
            case .error: return .red
            }
        }
    }

    let chips: [AgentChip]
    @Binding var selection: Set<String>     // engaged agent_ids
    let streamingAgentIDs: Set<String>      // agent_ids whose runtime is currently producing
    let onInterrupt: (String) -> Void
    /// When false the chips render as a bare HStack with no outer ScrollView
    /// and no extra padding — used when the composer's unified pre-send tray
    /// is the one providing horizontal scrolling, so we don't nest two
    /// scroll views. Default true preserves standalone-usage behavior.
    let wrappedInScrollView: Bool

    @State private var pendingInterrupt: AgentChip?

    public init(chips: [AgentChip],
                selection: Binding<Set<String>>,
                streamingAgentIDs: Set<String> = [],
                onInterrupt: @escaping (String) -> Void = { _ in },
                wrappedInScrollView: Bool = true) {
        self.chips = chips
        _selection = selection
        self.streamingAgentIDs = streamingAgentIDs
        self.onInterrupt = onInterrupt
        self.wrappedInScrollView = wrappedInScrollView
    }

    private var visibleChips: [AgentChip] {
        chips.filter { selection.contains($0.id) }
    }

    public var body: some View {
        if !visibleChips.isEmpty {
            Group {
                if wrappedInScrollView {
                    ScrollView(.horizontal, showsIndicators: false) {
                        chipsRow
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                    }
                } else {
                    chipsRow
                }
            }
            .alert(
                "Interrupt \(pendingInterrupt?.displayName ?? "agent")?",
                isPresented: Binding(
                    get: { pendingInterrupt != nil },
                    set: { if !$0 { pendingInterrupt = nil } }
                ),
                presenting: pendingInterrupt
            ) { chip in
                Button("Cancel", role: .cancel) { pendingInterrupt = nil }
                Button("Interrupt", role: .destructive) {
                    onInterrupt(chip.id)
                    pendingInterrupt = nil
                }
            } message: { chip in
                Text("Stop \(chip.displayName)'s current response. The message it was working on won't be saved.")
            }
        }
    }

    private var chipsRow: some View {
        HStack(spacing: 8) {
            ForEach(visibleChips) { chip in
                chipLabel(chip)
            }
        }
    }

    @ViewBuilder
    private func chipLabel(_ chip: AgentChip) -> some View {
        let streaming = streamingAgentIDs.contains(chip.id)
        HStack(spacing: 6) {
            Circle().fill(chip.runtimeState.color).frame(width: 6, height: 6)
            Text(chip.displayName).font(.caption.weight(.semibold))
            if streaming {
                Button {
                    pendingInterrupt = chip
                } label: {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(Color.amux.cinnabarDeep)
                        .padding(3)
                        .background(Circle().fill(Color.amux.cinnabar.opacity(0.22)))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Interrupt \(chip.displayName)"))
            } else {
                Button {
                    selection.remove(chip.id)
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(Color.amux.cinnabar)
                        .padding(3)
                        .background(Circle().fill(Color.amux.cinnabar.opacity(0.18)))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Remove \(chip.displayName)"))
            }
        }
        .padding(.leading, 10)
        .padding(.trailing, 6)
        .padding(.vertical, 4)
        // Opaque Paper base + Cinnabar tint on top — without the Paper
        // layer the 12%-alpha tint let the chat bubble below bleed
        // straight through the chip.
        .background(
            Capsule()
                .fill(Color.amux.paper)
                .overlay(Capsule().fill(Color.amux.cinnabar.opacity(0.12)))
        )
        .overlay(Capsule().stroke(Color.amux.cinnabar.opacity(0.6), lineWidth: 0.5))
    }
}

#Preview("Two chips, one streaming") {
    @Previewable @State var sel: Set<String> = ["a1", "a2"]
    return AgentChipBar(
        chips: [
            AgentChipBar.AgentChip(id: "a1", displayName: "miniA", runtimeState: .active),
            AgentChipBar.AgentChip(id: "a2", displayName: "miniB", runtimeState: .ready),
        ],
        selection: $sel,
        streamingAgentIDs: ["a1"],
        onInterrupt: { _ in }
    )
    .padding()
    .background(.background)
}

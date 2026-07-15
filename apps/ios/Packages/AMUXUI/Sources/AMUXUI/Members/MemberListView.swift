import SwiftUI
import SwiftData
import AMUXCore
import AMUXSharedUI

// MARK: - MemberListView (a.k.a. ActorPicker)

/// Sheet-style picker over `CachedActor` rows with search, kind badges,
/// and permission gating for agents. Pure multi-select: humans and agents
/// can all be picked together. The caller decides what to do with the
/// result — for sessions without a primary agent, the caller is expected
/// to follow up with a `PrimaryAgentSheet` to resolve which selected agent
/// becomes primary.
public struct MemberListView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    @Query(sort: \CachedActor.displayName)
    private var actors: [CachedActor]

    private let selectionMode: Bool
    private let accessibleAgentIDs: Set<String>
    private let currentPrimaryAgentID: String?
    private let excludeActorID: String?
    private let excludeActorIDs: Set<String>
    @State private var selectedIDs: Set<String>
    @State private var searchText: String = ""
    private let onConfirm: (([CachedActor]) -> Void)?
    /// Externally-tracked selection (used by NewSessionSheet to pre-mark
    /// agents that the parent has already configured via AgentConfigSheet).
    /// Combined with `selectedIDs` for the visual checkmark and for the
    /// final onConfirm payload.
    private let externallySelectedIDs: Set<String>
    /// When set, tapping an agent row delegates to the parent instead of
    /// toggling internal selection. The parent can present a follow-up
    /// sheet (e.g. AgentConfigSheet) and decide whether to track the agent
    /// in `externallySelectedIDs`.
    private let onAgentTap: ((CachedActor) -> Void)?

    /// Browse-only mode: tap rows to see detail.
    public init() {
        self.selectionMode = false
        self.accessibleAgentIDs = []
        self.currentPrimaryAgentID = nil
        self.excludeActorID = nil
        self.excludeActorIDs = []
        self._selectedIDs = State(initialValue: [])
        self.onConfirm = nil
        self.externallySelectedIDs = []
        self.onAgentTap = nil
    }

    /// Selection mode: multi-select with a confirm callback.
    public init(selected: Set<String> = [],
                accessibleAgentIDs: Set<String> = [],
                currentPrimaryAgentID: String? = nil,
                excludeActorID: String? = nil,
                excludeActorIDs: Set<String> = [],
                externallySelectedIDs: Set<String> = [],
                onAgentTap: ((CachedActor) -> Void)? = nil,
                onConfirm: @escaping (_ actors: [CachedActor]) -> Void) {
        self.selectionMode = true
        self.accessibleAgentIDs = accessibleAgentIDs
        self.currentPrimaryAgentID = currentPrimaryAgentID
        self.excludeActorID = excludeActorID
        self.excludeActorIDs = excludeActorIDs
        self._selectedIDs = State(initialValue: selected)
        self.onConfirm = onConfirm
        self.externallySelectedIDs = externallySelectedIDs
        self.onAgentTap = onAgentTap
    }

    private var visibleActors: [CachedActor] {
        // When the caller declares which agents we have access to, agents
        // outside that set are hidden from the picker (instead of shown
        // locked). Humans are always visible. Gateway-only external actors
        // are intentionally hidden here; they are message/session
        // participants, not selectable TeamClaw collaborators.
        // `excludeActorID` / `excludeActorIDs` hide the calling user (and
        // any pre-known participants) from the picker.
        var rows = actors.filter { $0.isMember || $0.isAgent }
        if let exclude = excludeActorID, !exclude.isEmpty {
            rows = rows.filter { $0.actorId != exclude }
        }
        if !excludeActorIDs.isEmpty {
            rows = rows.filter { !excludeActorIDs.contains($0.actorId) }
        }
        guard selectionMode, !accessibleAgentIDs.isEmpty else { return rows }
        return rows.filter { !$0.isAgent || accessibleAgentIDs.contains($0.actorId) }
    }

    private var filtered: [CachedActor] {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return visibleActors }
        let norm = q.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
        return visibleActors.filter { a in
            [a.displayName, a.roleLabel, a.defaultAgentType ?? "", a.actorId]
                .joined(separator: " ")
                .folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
                .contains(norm)
        }
    }

    public var body: some View {
        NavigationStack {
            List {
                ForEach(filtered, id: \.actorId) { actor in
                    Group {
                        if selectionMode {
                            selectionRow(actor)
                        } else {
                            NavigationLink {
                                MemberDetailView(member: actor)
                            } label: {
                                ActorRow(actor: actor, isPrimary: false, isLocked: false)
                            }
                        }
                    }
                    .listRowBackground(Color.amux.paper)
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Color.amux.mist)
            .searchable(text: $searchText, prompt: "Search actors")
            .navigationTitle("Actors").navigationBarTitleDisplayMode(.large)
            .toolbar {
                if selectionMode {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Button { dismiss() } label: {
                            Image(systemName: "xmark")
                                .font(.title3)
                                .foregroundStyle(.primary)
                        }
                        .accessibilityLabel("Cancel")
                        .buttonStyle(.plain)
                    }
                    ToolbarItem(placement: .navigationBarTrailing) {
                        let canConfirm = !(selectedIDs.isEmpty && externallySelectedIDs.isEmpty)
                        Button {
                            let union = selectedIDs.union(externallySelectedIDs)
                            let selected = actors.filter { union.contains($0.actorId) }
                            onConfirm?(selected)
                            dismiss()
                        } label: {
                            Image(systemName: "checkmark")
                                .font(.title3)
                                .foregroundStyle(canConfirm ? Color.amux.cinnabar : Color.amux.slate.opacity(0.5))
                        }
                        .accessibilityLabel("Confirm")
                        .buttonStyle(.plain)
                        .disabled(!canConfirm)
                    }
                } else {
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button { dismiss() } label: {
                            Image(systemName: "xmark")
                                .font(.title3)
                                .foregroundStyle(.primary)
                        }
                        .accessibilityLabel("Close")
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func isLocked(_ actor: CachedActor) -> Bool {
        actor.isAgent && !accessibleAgentIDs.contains(actor.actorId)
    }

    private func isPrimary(_ actor: CachedActor) -> Bool {
        actor.isAgent && currentPrimaryAgentID == actor.actorId
    }

    @ViewBuilder
    private func selectionRow(_ actor: CachedActor) -> some View {
        let locked = isLocked(actor)
        let appearsSelected = selectedIDs.contains(actor.actorId) || externallySelectedIDs.contains(actor.actorId)
        Button {
            guard !locked else { return }
            // Agents with an `onAgentTap` parent: every tap delegates so the
            // parent can present AgentConfigSheet (per-tap configuration is
            // the multi-agent UX). The parent reads
            // `externallySelectedIDs.contains(actor.actorId)` to know
            // whether this is a fresh add or a tap-to-deselect.
            if actor.isAgent, let onAgentTap {
                onAgentTap(actor)
                return
            }
            if selectedIDs.contains(actor.actorId) {
                selectedIDs.remove(actor.actorId)
            } else {
                selectedIDs.insert(actor.actorId)
            }
        } label: {
            HStack {
                Image(systemName: appearsSelected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(appearsSelected ? Color.amux.cinnabar
                                     : locked ? Color.amux.slate.opacity(0.4) : Color.amux.slate)
                    .font(.title3)
                ActorRow(actor: actor, isPrimary: isPrimary(actor), isLocked: locked)
            }
            .contentShape(Rectangle())
        }
        .tint(.primary)
        .disabled(locked)
    }
}

// MARK: - PrimaryAgentSheet

/// Second-step confirmation sheet used when a session has no primary agent
/// yet and the user has just picked one or more agents in the actor picker.
/// Asks them which of those agents should become the session's primary.
public struct PrimaryAgentSheet: View {
    @Environment(\.dismiss) private var dismiss
    private let candidates: [CachedActor]
    @State private var selectedID: String?
    private let onConfirm: (_ primaryAgentID: String) -> Void

    public init(candidates: [CachedActor],
                onConfirm: @escaping (String) -> Void) {
        self.candidates = candidates
        self._selectedID = State(initialValue: candidates.first?.actorId)
        self.onConfirm = onConfirm
    }

    public var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(candidates, id: \.actorId) { agent in
                        Button {
                            selectedID = agent.actorId
                        } label: {
                            HStack {
                                Image(systemName: selectedID == agent.actorId ? "largecircle.fill.circle" : "circle")
                                    .foregroundStyle(selectedID == agent.actorId ? Color.amux.cinnabar : Color.amux.slate)
                                    .font(.title3)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(agent.displayName).font(.body)
                                    if let agentType = agent.defaultAgentType, !agentType.isEmpty {
                                        Text(AgentConfigSheet.AgentType.fromStoredValue(agentType).label)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                } header: {
                    Text("Pick the agent that will drive this session")
                } footer: {
                    Text("The primary agent owns the session's model and receives prompts. Other agents and humans participate as collaborators.")
                }
            }
            .navigationTitle("Primary Agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        if let id = selectedID { onConfirm(id) }
                        dismiss()
                    } label: {
                        Image(systemName: "checkmark").font(.title3)
                    }
                    .buttonStyle(.plain)
                    .disabled(selectedID == nil)
                }
                ToolbarItem(placement: .navigationBarLeading) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.title3)
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

// MARK: - ActorRow

private struct ActorRow: View {
    let actor: CachedActor
    let isPrimary: Bool
    let isLocked: Bool

    private var subtitle: String {
        if actor.isMember {
            return actor.roleLabel
        }
        if actor.isAgent {
            let kind: String
            switch actor.defaultAgentType {
            case "claude", "claude_code": kind = "Claude"
            case "opencode":    kind = "OpenCode"
            case "codex":       kind = "Codex"
            default:            kind = "Agent"
            }
            let status = actor.agentStatus ?? ""
            return status.isEmpty ? kind : "\(kind) · \(status)"
        }
        return actor.actorType.capitalized
    }

    private var kindBadge: (String, Color) {
        // Both human and agent badges read in Basalt — the kind distinction
        // is communicated through copy ("Human"/"Agent") and the avatar
        // shape elsewhere; per "spare the vermillion", no extra color here.
        if actor.isMember {
            return ("Human", Color.amux.basalt)
        }
        if actor.isAgent {
            return ("Agent", Color.amux.basalt)
        }
        return ("External", Color.amux.basalt)
    }

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(actor.isOnline ? Color.amux.sage : Color.amux.slate.opacity(0.4))
                .frame(width: 8, height: 8)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(actor.displayName)
                        .font(.body)
                        .foregroundStyle(isLocked ? Color.amux.basalt : Color.amux.onyx)
                    Text(kindBadge.0)
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.amux.pebble, in: Capsule())
                        .foregroundStyle(kindBadge.1)
                    if isPrimary {
                        // Primary agent earns the only Cinnabar mark in the
                        // row — it's the one piece of state that materially
                        // changes how the session behaves.
                        Image(systemName: "star.fill")
                            .font(.caption)
                            .foregroundStyle(Color.amux.cinnabar)
                    }
                    if isLocked {
                        Image(systemName: "lock.fill")
                            .font(.caption)
                            .foregroundStyle(Color.amux.slate)
                    }
                }
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(Color.amux.basalt)
            }
            Spacer()
            if actor.isOwner {
                Image(systemName: "crown.fill")
                    .foregroundStyle(Color.amux.basalt)
                    .font(.caption)
            }
        }
        .opacity(isLocked ? 0.55 : 1)
    }
}

// MARK: - MemberDetailView

private struct MemberDetailView: View {
    let member: CachedActor

    @Query private var allMessages: [SessionMessage]
    @Query(sort: \Session.lastMessageAt, order: .reverse)
    private var allSessions: [Session]

    private var memberSessions: [Session] {
        let sessionIds = Set(
            allMessages
                .filter { $0.senderActorId == member.actorId }
                .map(\.sessionId)
        )
        return allSessions.filter { sessionIds.contains($0.sessionId) }
    }

    var body: some View {
        List {
            Section("Info") {
                LabeledContent("Name", value: member.displayName)
                LabeledContent("Role", value: member.roleLabel)
                LabeledContent("Joined", value: member.createdAt.formatted(date: .abbreviated, time: .shortened))
            }
            Section("Collab Sessions") {
                if memberSessions.isEmpty {
                    Text("No sessions yet")
                        .font(.body)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(memberSessions, id: \.sessionId) { session in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(session.title.isEmpty ? "(untitled)" : session.title)
                                .font(.body)
                            if let last = session.lastMessageAt {
                                Text(last.formatted(date: .abbreviated, time: .shortened))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            Section("ID") {
                Text(member.actorId)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
        .navigationTitle(member.displayName)
        .navigationBarTitleDisplayMode(.inline)
    }
}

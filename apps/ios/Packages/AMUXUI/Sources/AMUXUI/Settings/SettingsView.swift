import SwiftUI
import SwiftData
import AMUXSharedUI
import AMUXCore

public struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    /// Injected by AMUXApp's `ContentView` via `.environment(onboarding)`.
    /// Read at this scope to gate the anonymous-upgrade banner. Marked
    /// optional so the (unused) macOS shell or any host that forgets to
    /// inject still compiles cleanly.
    @Environment(AppOnboardingCoordinator.self) private var onboarding: AppOnboardingCoordinator?

    let connectedAgentsStore: ConnectedAgentsStore?
    let activeTeam: TeamSummary?
    let onSignOut: (() -> Void)?

    @State private var teamDetails: TeamDetails?
    @State private var teamLoadError: String?

    @State private var showSignOutConfirm = false
    @State private var showUpgradeSheet = false

    /// Cached actor row for the current member, used to source the
    /// identity-card display name without an extra RPC.
    @Query private var cachedActors: [CachedActor]

    public init(connectedAgentsStore: ConnectedAgentsStore?,
                activeTeam: TeamSummary? = nil,
                onSignOut: (() -> Void)? = nil) {
        self.connectedAgentsStore = connectedAgentsStore
        self.activeTeam = activeTeam
        self.onSignOut = onSignOut
    }

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—"
    }

    private var buildNumber: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "—"
    }

    private var currentActorID: String? {
        onboarding?.currentContext?.memberActorID
    }

    private var currentActor: CachedActor? {
        guard let id = currentActorID else { return nil }
        return cachedActors.first(where: { $0.actorId == id })
    }

    /// Friendly display name for the identity card. Falls back to a short
    /// "Anonymous" label when the user is on a guest session and we don't
    /// have a directory row yet.
    private var displayName: String {
        if let name = currentActor?.displayName, !name.isEmpty { return name }
        if onboarding?.isAnonymous == true { return "Guest" }
        return "—"
    }

    private var initials: String {
        let parts = displayName
            .split(whereSeparator: { $0.isWhitespace })
            .compactMap { $0.first }
        return String(parts.prefix(2)).uppercased()
    }

    public var body: some View {
        NavigationStack {
            ZStack {
                Color.amux.mist.ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 18) {
                        identityCard
                        if onboarding?.isAnonymous == true { upgradeBanner }
                        connectedAgentsSection
                        teamSection
                        aboutSection
                        if let id = currentActorID, !id.isEmpty {
                            footerCaption(actorID: id)
                        }
                    }
                    .padding(.top, 12)
                    .padding(.bottom, 24)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.title3)
                            .foregroundStyle(Color.amux.basalt)
                    }
                    .buttonStyle(.plain)
                }
            }
            .sheet(isPresented: $showUpgradeSheet) {
                if let onboarding {
                    UpgradeAccountSheet(coordinator: onboarding)
                }
            }
            .task {
                await loadTeam()
                await connectedAgentsStore?.reload()
            }
            .refreshable { await connectedAgentsStore?.reload() }
        }
    }

    // MARK: - Identity card

    private var identityCard: some View {
        HStack(spacing: 14) {
            ZStack {
                Circle().fill(Color.amux.cinnabar)
                Text(initials.isEmpty ? "·" : initials)
                    .font(.system(size: 20, weight: .bold))
                    .foregroundStyle(Color.amux.paper)
                    .tracking(-0.4)
            }
            .frame(width: 56, height: 56)

            VStack(alignment: .leading, spacing: 4) {
                Text(displayName)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(Color.amux.onyx)
                    .lineLimit(1)

                if let team = activeTeam {
                    HStack(spacing: 6) {
                        roleBadge(team.role)
                        Text("Team · \(team.name)")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Color.amux.basalt.opacity(0.75))
                            .lineLimit(1)
                    }
                } else if onboarding?.isAnonymous == true {
                    Text("Anonymous session")
                        .font(.system(size: 13))
                        .foregroundStyle(Color.amux.basalt)
                }
            }
            Spacer(minLength: 8)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(SettingsCardBackground())
        .padding(.horizontal, 16)
    }

    private func roleBadge(_ role: String) -> some View {
        let label = role.lowercased() == "owner" ? "Owner" : role.capitalized
        return Text(label.uppercased())
            .font(.system(size: 10, weight: .bold))
            .tracking(0.3)
            .foregroundStyle(Color.amux.basalt)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(Color.amux.basalt.opacity(0.14))
            )
    }

    private var upgradeBanner: some View {
        Button {
            showUpgradeSheet = true
        } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "person.badge.shield.checkmark")
                    .font(.title2)
                    .foregroundStyle(Color.amux.cinnabar)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Upgrade your account")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Color.amux.onyx)
                    Text("You're signed in anonymously. Attach an email or Apple ID to keep this workspace.")
                        .font(.footnote)
                        .foregroundStyle(Color.amux.basalt)
                        .multilineTextAlignment(.leading)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.amux.slate)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .background(SettingsCardBackground())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("settings.upgradeAccountButton")
        .padding(.horizontal, 16)
    }

    // MARK: - Connected agents (was "Daemon" in prototype)

    private var connectedAgentsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsSectionLabel("Connected Agents")
            VStack(spacing: 0) {
                if let store = connectedAgentsStore {
                    if store.agents.isEmpty && !store.isLoading {
                        emptyAgentsRow
                    } else {
                        ForEach(Array(store.agents.enumerated()), id: \.element.id) { idx, agent in
                            connectedAgentRow(agent)
                            if idx != store.agents.count - 1 {
                                Rectangle().fill(Color.amux.hairline).frame(height: 0.5)
                                    .padding(.leading, 14)
                            }
                        }
                    }
                    if let err = store.errorMessage {
                        Rectangle().fill(Color.amux.hairline).frame(height: 0.5)
                        Text(err)
                            .font(.footnote)
                            .foregroundStyle(Color.amux.cinnabarDeep)
                            .padding(14)
                    }
                } else {
                    Text("Agent list unavailable.")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.amux.basalt)
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .background(SettingsCardBackground())
            .padding(.horizontal, 16)
        }
    }

    private func connectedAgentRow(_ agent: ConnectedAgent) -> some View {
        let dotColor: Color = agent.isOnline ? Color.amux.sage : Color.amux.slate
        let metaParts: [String] = [agent.agentKind, agent.permissionLevel]
            .filter { !$0.isEmpty }
        let meta = metaParts.joined(separator: " · ")
        return HStack(spacing: 10) {
            ZStack {
                Circle().fill(dotColor)
            }
            .frame(width: 8, height: 8)

            VStack(alignment: .leading, spacing: 2) {
                Text(agent.displayName)
                    .font(.system(size: 14.5, weight: .semibold))
                    .foregroundStyle(Color.amux.onyx)
                    .lineLimit(1)
                Text(meta.isEmpty ? (agent.isOnline ? "online" : "offline") : meta)
                    .font(.system(size: 11.5, design: .monospaced))
                    .foregroundStyle(Color.amux.basalt.opacity(0.75))
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Text(agent.isOnline ? "Online" : "Offline")
                .font(.system(size: 13))
                .foregroundStyle(dotColor)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    private var emptyAgentsRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("No agents connected to you yet.")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color.amux.onyx)
            Text("Ask a teammate with admin access to authorize one, or invite a new daemon from the Actors tab.")
                .font(.footnote)
                .foregroundStyle(Color.amux.basalt)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Team

    @ViewBuilder
    private var teamSection: some View {
        if activeTeam == nil {
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: 8) {
                SettingsSectionLabel("Team")
                VStack(spacing: 0) {
                    if let details = teamDetails {
                        SettingsRow(label: "Name", value: details.name)
                        Divider().background(Color.amux.hairline).padding(.leading, 14)
                        SettingsRow(label: "Owner", value: details.ownerDisplayName ?? "—")
                        Divider().background(Color.amux.hairline).padding(.leading, 14)
                        SettingsRow(
                            label: "Created",
                            value: details.createdAt.formatted(date: .abbreviated, time: .shortened)
                        )
                        Divider().background(Color.amux.hairline).padding(.leading, 14)
                        SettingsRow(label: "ID", value: details.id, valueIsMonospaced: true)
                    } else if let err = teamLoadError {
                        Text(err)
                            .font(.footnote)
                            .foregroundStyle(Color.amux.cinnabarDeep)
                            .padding(14)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        ProgressView()
                            .padding(14)
                            .frame(maxWidth: .infinity)
                    }
                }
                .background(SettingsCardBackground())
                .padding(.horizontal, 16)
            }
        }
    }

    // MARK: - About + Sign out

    private var aboutSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsSectionLabel("About")
            VStack(spacing: 0) {
                SettingsRow(
                    label: "Version",
                    value: "\(appVersion) (\(buildNumber))",
                    valueIsMonospaced: true
                )
                if onSignOut != nil {
                    Divider().background(Color.amux.hairline).padding(.leading, 14)
                    Button {
                        showSignOutConfirm = true
                    } label: {
                        HStack {
                            Text("Sign Out")
                                .font(.system(size: 14.5, weight: .medium))
                                .foregroundStyle(Color.amux.cinnabarDeep)
                            Spacer()
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 13)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("settings.signOutButton")
                    // Attach the confirmation dialog to the button that
                    // triggers it so iOS 26's Liquid Glass popover style
                    // anchors at the tapped row. When the modifier was on
                    // the NavigationStack root, the arrow pointed at the
                    // top of the sheet (near the identity card) instead
                    // of the bottom-of-list Sign Out row the user tapped.
                    .confirmationDialog(
                        "Sign out of Teamclaw?",
                        isPresented: $showSignOutConfirm,
                        titleVisibility: .visible
                    ) {
                        Button("Sign Out", role: .destructive) {
                            let action = onSignOut
                            dismiss()
                            action?()
                        }
                        Button("Cancel", role: .cancel) {}
                    }
                }
            }
            .background(SettingsCardBackground())
            .padding(.horizontal, 16)
        }
    }

    private func footerCaption(actorID: String) -> some View {
        Text(actorID)
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(Color.amux.slate)
            .padding(.top, 4)
            .frame(maxWidth: .infinity)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 24)
    }

    private func loadTeam() async {
        guard let team = activeTeam else { return }
        do {
            let repo = try SupabaseTeamRepository()
            teamDetails = try await repo.loadDetails(teamID: team.id)
            teamLoadError = nil
        } catch {
            teamLoadError = error.localizedDescription
        }
    }
}

// MARK: - Hai shared building blocks (file-private)

/// Paper card background tuned for the Mist Settings surface — soft
/// rounded edges with a faint hairline so cards still read against
/// Mist without a heavy shadow.
private struct SettingsCardBackground: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 14, style: .continuous)
            .fill(Color.amux.paper)
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(Color.amux.hairline, lineWidth: 0.5)
            )
    }
}

/// Uppercased Basalt label that sits above each grouped Settings card,
/// matching the prototype's `SectionLabel` typography.
private struct SettingsSectionLabel: View {
    let title: String
    init(_ title: String) { self.title = title }
    var body: some View {
        Text(title.uppercased())
            .font(.system(size: 11, weight: .semibold))
            .tracking(0.6)
            .foregroundStyle(Color.amux.basalt.opacity(0.7))
            .padding(.horizontal, 24)
    }
}

/// Single key/value row used inside Settings cards — Onyx label on the
/// left, Basalt value on the right, monospaced when asked. Visual twin of
/// the prototype's `SheetRow` (without a chevron, since none of the rows
/// here drill into another screen yet).
private struct SettingsRow: View {
    let label: String
    let value: String
    let valueIsMonospaced: Bool
    init(label: String, value: String, valueIsMonospaced: Bool = false) {
        self.label = label
        self.value = value
        self.valueIsMonospaced = valueIsMonospaced
    }
    var body: some View {
        HStack(spacing: 8) {
            Text(label)
                .font(.system(size: 14.5))
                .foregroundStyle(Color.amux.onyx)
            Spacer(minLength: 8)
            Text(value)
                .font(.system(
                    size: 13.5,
                    design: valueIsMonospaced ? .monospaced : .default
                ))
                .foregroundStyle(Color.amux.basalt)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 13)
    }
}

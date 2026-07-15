import SwiftUI
import SwiftData
import AMUXCore
import AMUXSharedUI

public struct ShortcutsDrawer: View {
    @Binding var isPresented: Bool
    @Bindable var store: ShortcutsStore
    let currentActorID: String?
    let activeTeam: TeamSummary?
    let onOpenSettings: () -> Void

    @Query private var cachedActors: [CachedActor]
    @State private var expandedIDs: Set<String> = []
    @State private var presentedLink: ShortcutLinkPresentation?

    public init(isPresented: Binding<Bool>,
                store: ShortcutsStore,
                currentActorID: String? = nil,
                activeTeam: TeamSummary? = nil,
                onOpenSettings: @escaping () -> Void) {
        self._isPresented = isPresented
        self.store = store
        self.currentActorID = currentActorID
        self.activeTeam = activeTeam
        self.onOpenSettings = onOpenSettings
    }

    public var body: some View {
        GeometryReader { geometry in
            let drawerWidth = min(360, geometry.size.width * 0.86)
            ZStack(alignment: .leading) {
                if isPresented {
                    Color.amux.onyx
                        .opacity(0.22)
                        .ignoresSafeArea()
                        .onTapGesture { close() }
                        .transition(.opacity)

                    drawer(width: drawerWidth)
                        .transition(.move(edge: .leading))
                        .gesture(closeDrag)
                        .zIndex(1)
                }
            }
            .animation(.spring(response: 0.42, dampingFraction: 0.86), value: isPresented)
        }
        .fullScreenCover(item: $presentedLink) { link in
            ShortcutWebScreen(title: link.title, url: link.url) {
                presentedLink = nil
            }
        }
    }

    // MARK: - Drawer layout

    private func drawer(width: CGFloat) -> some View {
        VStack(spacing: 0) {
            profileHeader
            shortcutList
        }
        .frame(width: width)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Color.amux.mist)
        .ignoresSafeArea(edges: [.leading, .bottom])
    }

    // MARK: - Profile header

    private var currentActor: CachedActor? {
        guard let id = currentActorID else { return nil }
        return cachedActors.first(where: { $0.actorId == id })
    }

    private var profileDisplayName: String {
        if let name = currentActor?.displayName, !name.isEmpty { return name }
        return activeTeam?.name ?? "Signed out"
    }

    private var profileSubtitle: String? {
        if let role = currentActor?.roleLabel, role != "—" { return role }
        if let team = activeTeam?.name { return "Team · \(team)" }
        return nil
    }

    private var profileHeader: some View {
        VStack(spacing: 0) {
            HStack(spacing: 14) {
                ProfileAvatarView(
                    displayName: profileDisplayName,
                    avatarURL: currentActor?.avatarURL,
                    size: 44,
                    fontSize: 16
                )

                VStack(alignment: .leading, spacing: 2) {
                    Text(profileDisplayName)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Color.amux.onyx)
                        .lineLimit(1)

                    if let subtitle = profileSubtitle {
                        Text(subtitle)
                            .font(.system(size: 13))
                            .foregroundStyle(Color.amux.slate)
                            .lineLimit(1)
                    }
                }

                Spacer(minLength: 6)

                settingsHeaderButton
            }
            .padding(.horizontal, 20)
            .padding(.top, 18)
            .padding(.bottom, 14)

            Rectangle()
                .fill(Color.amux.hairline)
                .frame(height: 0.5)
                .padding(.horizontal, 20)
        }
    }

    private var appVersion: String {
        let short = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—"
        return "v\(short)"
    }

    private var settingsHeaderButton: some View {
        Button(action: handleSettingsTap) {
            HStack(spacing: 6) {
                Image(systemName: "gearshape")
                    .font(.system(size: 14, weight: .regular))

                Text(appVersion)
                    .font(.system(size: 12, weight: .regular, design: .monospaced))

                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
            }
            .foregroundStyle(Color.amux.slate)
            .padding(.horizontal, 8)
            .padding(.vertical, 7)
            .background(
                Capsule()
                    .fill(Color.amux.pebble.opacity(0.55))
            )
            .contentShape(Capsule())
        }
        .buttonStyle(SettingsRowButtonStyle())
        .accessibilityIdentifier("shortcuts.settingsButton")
        .accessibilityLabel("Settings")
    }

    // MARK: - List content

    private var shortcutList: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                section(title: "Personal", scope: .personal)
                section(title: "Team", scope: .team)

                if let err = store.errorMessage {
                    Text(err)
                        .font(.system(size: 12))
                        .foregroundStyle(Color.amux.slate)
                        .padding(.horizontal, 20)
                        .padding(.top, 4)
                }
            }
            .padding(.top, 16)
            .padding(.bottom, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color.amux.mist)
        .refreshable {
            await store.reload()
        }
        .task {
            await store.reload()
        }
        .overlay {
            if store.isLoading && allRootNodesAreEmpty {
                ProgressView().tint(Color.amux.basalt)
            } else if allRootNodesAreEmpty {
                emptyState
                    .padding(24)
            }
        }
    }

    private func section(title: String, scope: ShortcutScope) -> some View {
        let roots = store.children(parentID: nil, scope: scope)
        return Group {
            if !roots.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    sectionHeader(title: title, count: roots.count)
                    VStack(spacing: 0) {
                        ForEach(roots) { node in
                            ShortcutMenuRow(
                                node: node,
                                store: store,
                                depth: 0,
                                expandedIDs: $expandedIDs,
                                onSelectLink: { url, title in
                                    presentedLink = ShortcutLinkPresentation(url: url, title: title)
                                }
                            )
                        }
                    }
                }
            }
        }
    }

    private func sectionHeader(title: String, count: Int) -> some View {
        Text("\(title.uppercased()) · \(count)")
            .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
            .tracking(0.4)
            .foregroundStyle(Color.amux.slate)
            .padding(.horizontal, 20)
            .padding(.bottom, 2)
    }

    // MARK: - Empty / loading state

    private var emptyState: some View {
        ContentUnavailableView(
            "No Shortcuts",
            systemImage: "star",
            description: Text("Shortcuts you or your team create will appear here.")
        )
        .foregroundStyle(Color.amux.basalt)
    }

    private var allRootNodesAreEmpty: Bool {
        store.children(parentID: nil, scope: .personal).isEmpty
            && store.children(parentID: nil, scope: .team).isEmpty
    }

    // MARK: - Gestures

    private var closeDrag: some Gesture {
        DragGesture(minimumDistance: 16)
            .onEnded { value in
                if value.translation.width < -56 || value.predictedEndTranslation.width < -120 {
                    close()
                }
            }
    }

    private func close() {
        isPresented = false
    }

    /// Close the drawer first, then ask the host to present SettingsView on the
    /// next runloop tick. Presenting the sheet from inside the drawer would
    /// tear it down on dismiss; routing through the host keeps the sheet alive
    /// even after the drawer animates away.
    private func handleSettingsTap() {
        close()
        DispatchQueue.main.async {
            onOpenSettings()
        }
    }
}

private struct SettingsRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Color.amux.onyx.opacity(0.04) : Color.clear)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct ShortcutLinkPresentation: Identifiable, Equatable {
    let id: String
    let url: URL
    let title: String

    init(url: URL, title: String) {
        self.id = url.absoluteString
        self.url = url
        self.title = title
    }
}

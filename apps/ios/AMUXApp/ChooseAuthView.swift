import SwiftUI
import AMUXCore
import AMUXSharedUI

/// Sits between WelcomeView and LoginView. Three paths (anonymous sign-in
/// was removed from the product):
///   - "Sign in or register" → push the existing LoginView
///   - join a team → paste an invite token, then sign in; the token replays
///     through the invite-claim pipeline once RootTabView mounts
///   - custom server → point the app at a self-hosted Cloud API before
///     signing in (mirrors the desktop's server entry)
struct ChooseAuthView: View {
    @Bindable var coordinator: AppOnboardingCoordinator
    /// Called after the user saves a different server address so the app
    /// shell can rebuild the Cloud API stack against it.
    var onServerChanged: () -> Void = {}
    @State private var showLogin = false
    @State private var showInviteSheet = false
    @State private var showServerSettings = false
    /// Bumped after every server-sheet save so the row's caption re-reads
    /// the stored address.
    @State private var serverEpoch = 0

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.top, 58)
                .padding(.horizontal, 28)

            Spacer(minLength: 0)

            VStack(spacing: 12) {
                actionRow(
                    icon: "envelope",
                    title: String(localized: "Sign in or register"),
                    caption: String(localized: "Use email, Apple, or Google to sync across devices."),
                    isPrimary: true
                ) {
                    showLogin = true
                }
                .accessibilityIdentifier("choose.signInButton")

                actionRow(
                    icon: "link",
                    title: String(localized: "Join a team"),
                    caption: String(localized: "Paste an invite link from a teammate."),
                    isPrimary: false
                ) {
                    showInviteSheet = true
                }
                .disabled(coordinator.isBusy)

                actionRow(
                    icon: "server.rack",
                    title: String(localized: "Custom server"),
                    caption: serverCaption,
                    isPrimary: false
                ) {
                    showServerSettings = true
                }
                .accessibilityIdentifier("choose.customServerButton")

            }
            .padding(.horizontal, 24)

            if let err = coordinator.errorMessage {
                Text(err)
                    .font(.footnote)
                    .foregroundStyle(Color.amux.cinnabarDeep)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 28)
            }

            Spacer(minLength: 0)
        }
        .padding(.bottom, 32)
        .background(Color.amux.mist)
        .navigationDestination(isPresented: $showLogin) {
            LoginView(coordinator: coordinator)
        }
        .sheet(isPresented: $showServerSettings) {
            ServerSettingsSheet(onSaved: {
                serverEpoch += 1
                onServerChanged()
            })
        }
        .sheet(isPresented: $showInviteSheet) {
            InviteJoinSheet(coordinator: coordinator) { token in
                // "I already have an account": stash the token and route to
                // sign-in. After the user signs in, `bootstrap()` claims the
                // token as that account, so an existing user joins the team
                // (keeping their other teams) instead of being forced into a
                // throwaway anonymous identity.
                coordinator.pendingInviteToken = token
                showLogin = true
            }
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
        }
    }

    /// Names the server the app currently points at, so a self-host user
    /// can tell at a glance whether their override took.
    private var serverCaption: String {
        _ = serverEpoch
        if CloudAPIConfigurationStore.hasCloudAPIURLOverride(),
           let raw = CloudAPIConfigurationStore.storedCloudAPIURL(),
           let host = URL(string: raw)?.host {
            return String(localized: "Connected to \(host).")
        }
        return String(localized: "Point the app at your own deployment.")
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Set up TeamClu")
                .font(.amuxSerif(34, weight: .regular))
                .foregroundStyle(Color.amux.onyx)
            Text("Create your workspace or join the team that already works with your AI allies.")
                .font(.body)
                .foregroundStyle(Color.amux.basalt)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func actionRow(
        icon: String,
        title: String,
        caption: String,
        isPrimary: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 13) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(isPrimary ? Color.amux.cinnabar : Color.amux.pebble)
                    Image(systemName: icon)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(isPrimary ? Color.white : Color.amux.basalt)
                }
                .frame(width: 38, height: 38)

                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Color.amux.onyx)
                    Text(caption)
                        .font(.caption)
                        .foregroundStyle(Color.amux.basalt)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 8)

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.amux.slate)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(isPrimary ? Color.amux.paper : Color.amux.paper.opacity(0.76))
                    .shadow(color: Color.amux.onyx.opacity(isPrimary ? 0.08 : 0.04),
                            radius: isPrimary ? 18 : 10,
                            x: 0,
                            y: isPrimary ? 10 : 5)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(isPrimary ? Color.amux.cinnabar.opacity(0.22) : Color.amux.hairline, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(coordinator.isBusy)
    }
}

// MARK: - InviteJoinSheet

/// Lets the user paste a `teamclu://invite?token=…` link (or a bare token)
/// before they have a session. Two paths: "Continue" joins anonymously (then
/// RootTabView replays the token through the usual claim pipeline), or "I
/// already have an account" routes to sign-in with the token stashed so an
/// existing user joins the team under their real identity.
private struct InviteJoinSheet: View {
    @Bindable var coordinator: AppOnboardingCoordinator
    @Environment(\.dismiss) private var dismiss
    @State private var raw: String = ""
    @State private var localError: String?

    /// Called with the parsed token when the user chooses to sign in to an
    /// existing account instead of joining anonymously.
    let onUseExistingAccount: (String) -> Void

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Join with invite link")
                        .font(.title2.bold())
                    Text("Paste the link your teammate shared. Continue as a guest, or sign in to an account you already have.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                TextField("teamclu://invite?token=… or just the token",
                          text: $raw,
                          axis: .vertical)
                    .lineLimit(2...4)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(12)
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(Color.amux.pebble)
                    )
                    .onChange(of: raw) { _, _ in
                        // Clear stale errors as soon as the user edits the
                        // field so a retry doesn't show last attempt's copy.
                        if localError != nil { localError = nil }
                        if coordinator.errorMessage != nil { coordinator.errorMessage = nil }
                    }

                if let inlineError {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(Color.amux.cinnabar)
                        Text(inlineError)
                            .font(.footnote)
                            .foregroundStyle(Color.amux.onyx)
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(Color.amux.cinnabar.opacity(0.10))
                    )
                }

                Button {
                    submit()
                } label: {
                    Text(coordinator.isBusy ? "Joining…" : "Continue")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 4)
                }
                .glassProminentButtonStyle()
                .controlSize(.large)
                .disabled(coordinator.isBusy ||
                          raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                Button {
                    useExistingAccount()
                } label: {
                    Text("I already have an account")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 4)
                }
                .buttonStyle(.plain)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color.amux.cinnabar)
                .disabled(coordinator.isBusy ||
                          raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("invite.useExistingAccountButton")

                Spacer(minLength: 0)
            }
            .padding(20)
            .navigationTitle("Invite")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private var inlineError: String? {
        if let local = localError, !local.isEmpty { return local }
        if let remote = coordinator.errorMessage, !remote.isEmpty { return remote }
        return nil
    }

    private func submit() {
        guard let token = parseToken(raw) else {
            localError = String(localized: "Couldn't read a token from that link.")
            return
        }
        localError = nil
        coordinator.errorMessage = nil
        Task {
            await coordinator.claimInviteSmart(token: token)
            await MainActor.run {
                // Only dismiss on success — on failure the sheet stays open
                // with the error inline so the user can paste a new token
                // without navigating back through Welcome → ChooseAuth.
                if coordinator.route == .ready {
                    dismiss()
                }
            }
        }
    }

    private func useExistingAccount() {
        guard let token = parseToken(raw) else {
            localError = String(localized: "Couldn't read a token from that link.")
            return
        }
        localError = nil
        coordinator.errorMessage = nil
        dismiss()
        onUseExistingAccount(token)
    }

    /// Accepts both `teamclu://invite?token=XYZ` and bare `XYZ`. Trims whitespace.
    private func parseToken(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let url = URL(string: trimmed),
           let scheme = url.scheme,
           ["teamclu", "teamclaw", "amux"].contains(scheme), url.host == "invite",
           let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
           let token = comps.queryItems?.first(where: { $0.name == "token" })?.value,
           !token.isEmpty {
            return token
        }
        // Treat raw input without a URL scheme as the bare token.
        if !trimmed.contains("://") {
            return trimmed
        }
        return nil
    }
}

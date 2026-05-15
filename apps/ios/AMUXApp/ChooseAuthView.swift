import SwiftUI
import AMUXCore
import AMUXSharedUI

/// Sits between WelcomeView and LoginView. Three paths:
///   - "Try it first" → anonymous Supabase sign-in + auto-created random team
///   - "Sign in or register" → push the existing LoginView
///   - "Have an invite link?" → paste token, anonymous sign-in, replay token
///     through the existing invite-claim pipeline once RootTabView mounts
struct ChooseAuthView: View {
    @Bindable var coordinator: AppOnboardingCoordinator
    @State private var showLogin = false
    @State private var showInviteSheet = false

    var body: some View {
        VStack(spacing: 28) {
            VStack(spacing: 12) {
                Image(systemName: "rectangle.3.group")
                    .font(.system(size: 44))
                    .foregroundStyle(Color.amux.cinnabar)
                Text("Welcome to Teamclaw")
                    .font(.amuxSerif(28, weight: .regular))
                    .foregroundStyle(Color.amux.onyx)
                Text("Pick how you want to start.")
                    .font(.body)
                    .foregroundStyle(Color.amux.basalt)
            }
            .padding(.top, 32)

            Spacer(minLength: 0)

            VStack(spacing: 18) {
                authOption(
                    icon: "sparkles",
                    title: "Try it first",
                    caption: "Anonymous workspace, no email needed.",
                    isProminent: true
                ) {
                    Task { await coordinator.signInAnonymously() }
                }
                .accessibilityIdentifier("choose.anonymousButton")

                authOption(
                    icon: "envelope",
                    title: "Sign in or register",
                    caption: "Email, Apple, or Google. Saves your work across devices.",
                    isProminent: false
                ) {
                    showLogin = true
                }
                .accessibilityIdentifier("choose.signInButton")
            }
            .padding(.horizontal, 28)

            inviteEntry
                .padding(.horizontal, 28)

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
        .sheet(isPresented: $showInviteSheet) {
            InviteJoinSheet(coordinator: coordinator)
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
        }
    }

    @ViewBuilder
    private func authOption(
        icon: String,
        title: String,
        caption: String,
        isProminent: Bool,
        action: @escaping () -> Void
    ) -> some View {
        VStack(spacing: 6) {
            Button(action: action) {
                HStack(spacing: 10) {
                    Image(systemName: icon)
                        .font(.body.weight(.semibold))
                    Text(title)
                        .font(.body.weight(.semibold))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
            }
            .modifier(AuthButtonStyle(isProminent: isProminent))
            .controlSize(.large)
            .disabled(coordinator.isBusy)

            Text(caption)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
        }
    }

    private var inviteEntry: some View {
        VStack(spacing: 14) {
            HStack(spacing: 10) {
                Rectangle().fill(Color.secondary.opacity(0.2)).frame(height: 0.5)
                Text("OR")
                    .font(.caption2.weight(.semibold))
                    .tracking(0.5)
                    .foregroundStyle(.tertiary)
                Rectangle().fill(Color.secondary.opacity(0.2)).frame(height: 0.5)
            }

            Button {
                showInviteSheet = true
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "link")
                        .font(.caption.weight(.medium))
                    Text("Have an invite link? Tap to join")
                        .font(.subheadline.weight(.medium))
                }
                .foregroundStyle(.tint)
            }
            .buttonStyle(.plain)
            .disabled(coordinator.isBusy)
        }
    }
}

private struct AuthButtonStyle: ViewModifier {
    let isProminent: Bool
    func body(content: Content) -> some View {
        if isProminent {
            content.glassProminentButtonStyle()
        } else {
            content.glassButtonStyle()
        }
    }
}

// MARK: - InviteJoinSheet

/// Lets the user paste an `amux://invite?token=…` link (or a bare token)
/// before they have a session. Stashes the parsed token on the coordinator
/// and starts anonymous sign-in. RootTabView replays the token through the
/// usual claim-invite pipeline once it mounts.
private struct InviteJoinSheet: View {
    @Bindable var coordinator: AppOnboardingCoordinator
    @Environment(\.dismiss) private var dismiss
    @State private var raw: String = ""
    @State private var localError: String?

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Join with invite link")
                        .font(.title2.bold())
                    Text("Paste the link your teammate shared. Teamclaw will sign you in and add you to their team.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                TextField("amux://invite?token=… or just the token",
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
            localError = "Couldn't read a token from that link."
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

    /// Accepts both `amux://invite?token=XYZ` and bare `XYZ`. Trims whitespace.
    private func parseToken(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let url = URL(string: trimmed),
           url.scheme == "amux", url.host == "invite",
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

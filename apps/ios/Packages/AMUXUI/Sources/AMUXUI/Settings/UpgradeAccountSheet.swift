import SwiftUI
import AMUXSharedUI
import AMUXCore

/// Presented from Settings when the current session is anonymous. Lets the
/// user attach permanent credentials (email+password or Apple) to keep the
/// existing user_id and all team / actor / agent_member_access rows.
struct UpgradeAccountSheet: View {
    @Bindable var coordinator: AppOnboardingCoordinator
    @Environment(\.dismiss) private var dismiss
    @State private var email = ""
    @State private var password = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Upgrade your account")
                            .font(.title2.bold())
                        Text("Attach a permanent identity so you don't lose access to this workspace.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }

                    VStack(spacing: 12) {
                        TextField("Email", text: $email)
                            .textContentType(.emailAddress)
                            .keyboardType(.emailAddress)
                            .autocapitalization(.none)
                            .autocorrectionDisabled()
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                            .liquidGlass(in: RoundedRectangle(cornerRadius: 16), interactive: false)
                            .accessibilityIdentifier("upgrade.emailField")

                        SecureField("Password", text: $password)
                            .textContentType(.newPassword)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                            .liquidGlass(in: RoundedRectangle(cornerRadius: 16), interactive: false)
                            .accessibilityIdentifier("upgrade.passwordField")
                    }

                    if let err = coordinator.errorMessage {
                        Text(err).font(.footnote).foregroundStyle(Color.amux.cinnabarDeep)
                    }

                    Button {
                        Task {
                            await coordinator.upgradeWithPassword(email: email, password: password)
                            if !coordinator.isAnonymous {
                                dismiss()
                            }
                        }
                    } label: {
                        HStack {
                            if coordinator.isBusy { ProgressView().progressViewStyle(.circular).tint(.white) }
                            Text("Upgrade with Email").fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                    }
                    .glassProminentButtonStyle()
                    .disabled(coordinator.isBusy || email.isEmpty || password.isEmpty)
                    .accessibilityIdentifier("upgrade.submitButton")

                    HStack {
                        Rectangle().frame(height: 1).foregroundStyle(.separator)
                        Text("or").font(.footnote).foregroundStyle(.secondary)
                        Rectangle().frame(height: 1).foregroundStyle(.separator)
                    }

                    Button {
                        Task {
                            await coordinator.upgradeWithApple()
                            if !coordinator.isAnonymous {
                                dismiss()
                            }
                        }
                    } label: {
                        Label("Upgrade with Apple", systemImage: "applelogo")
                            .fontWeight(.semibold)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                    }
                    .glassButtonStyle()
                    .disabled(coordinator.isBusy)

                    Text("After upgrading, sign in with the same email next time you launch Teamclaw.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(24)
            }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}

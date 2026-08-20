import SwiftUI
import AMUXCore

/// Invites addressed to the signed-in user's verified contact. Accepting
/// joins the team and lands on it (the sheet dismisses because the whole
/// shell re-routes); declining removes the row in place.
struct PendingInvitesSheet: View {
    let coordinator: AppOnboardingCoordinator
    @Environment(\.dismiss) private var dismiss
    @State private var busyInviteID: String?

    var body: some View {
        NavigationStack {
            List {
                if coordinator.pendingInvites.isEmpty {
                    ContentUnavailableView(
                        "No Pending Invites",
                        systemImage: "envelope.open",
                        description: Text("Invites sent to your email or phone show up here.")
                    )
                    .listRowBackground(Color.clear)
                } else {
                    ForEach(coordinator.pendingInvites) { invite in
                        inviteRow(invite)
                    }
                }
            }
            .navigationTitle("Pending Invites")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await coordinator.refreshPendingInvites() }
            .refreshable { await coordinator.refreshPendingInvites() }
        }
    }

    @ViewBuilder
    private func inviteRow(_ invite: PendingInvite) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(invite.teamName ?? "Unnamed team")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.amux.onyx)
                if let inviter = invite.invitedByDisplayName, !inviter.isEmpty {
                    Text("Invited by \(inviter)")
                        .font(.caption)
                        .foregroundStyle(Color.amux.slate)
                }
                if let role = invite.teamRole, !role.isEmpty {
                    Text("Role: \(role)")
                        .font(.caption)
                        .foregroundStyle(Color.amux.slate)
                }
            }

            HStack(spacing: 12) {
                Button {
                    let id = invite.id
                    busyInviteID = id
                    Task {
                        _ = await coordinator.declinePendingInvite(invite)
                        busyInviteID = nil
                    }
                } label: {
                    Text("Decline")
                        .font(.subheadline.weight(.medium))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .foregroundStyle(Color.amux.cinnabarDeep)
                        .background(Color.amux.cinnabarDeep.opacity(0.10), in: Capsule())
                }
                .buttonStyle(.plain)

                Button {
                    let id = invite.id
                    busyInviteID = id
                    Task {
                        let landed = await coordinator.acceptPendingInvite(invite)
                        busyInviteID = nil
                        // Landing re-routes the whole shell; dismiss so the
                        // sheet isn't left over the new team.
                        if landed { dismiss() }
                    }
                } label: {
                    if busyInviteID == invite.id {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                    } else {
                        Text("Join")
                            .font(.subheadline.weight(.medium))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .foregroundStyle(Color.amux.sage)
                            .background(Color.amux.sage.opacity(0.18), in: Capsule())
                    }
                }
                .buttonStyle(.plain)
            }
            .disabled(busyInviteID != nil)
        }
        .padding(.vertical, 4)
    }
}

import SwiftUI

/// Lightweight reminder shown the first time a member opens a team that has
/// zero agent actors. Pure presentation — the parent decides what tapping
/// "Add agent" does (typically: dismiss this sheet and present the existing
/// MemberInviteSheet).
struct ZeroAgentReminderSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onAdd: () -> Void

    var body: some View {
        VStack(spacing: 24) {
            Spacer(minLength: 0)
            VStack(spacing: 16) {
                Image(systemName: "cpu")
                    .font(.system(size: 56))
                    .foregroundStyle(.tint)
                Text("Add your first agent")
                    .font(.title2.bold())
                Text("This team doesn't have any agents yet. Add one to start streaming sessions.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 16)
            }
            Spacer(minLength: 0)
            VStack(spacing: 10) {
                Button {
                    onAdd()
                    dismiss()
                } label: {
                    Text("Add agent").fontWeight(.semibold)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                }
                .glassProminentButtonStyle()
                .accessibilityIdentifier("zeroAgent.addButton")

                Button("Maybe later") { dismiss() }
                    .font(.footnote)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 32)
        }
        .padding(.top, 24)
        .presentationDetents([.medium])
    }
}

import SwiftUI
import AMUXSharedUI
import AMUXCore
import AMUXUI

struct CreateTeamView: View {
    @Bindable var coordinator: AppOnboardingCoordinator
    @State private var teamName = ""

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 24) {
                Spacer(minLength: 0)

                VStack(alignment: .leading, spacing: 12) {
                    Text("Create Your Team")
                        .font(.largeTitle.bold())
                    Text("Name the team you'll be collaborating with. You can invite teammates and agents after this.")
                        .font(.body)
                        .foregroundStyle(.secondary)
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text("Team Name")
                        .font(.headline)
                    TextField("Teamclaw Team", text: $teamName)
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
                }

                if let errorMessage = coordinator.errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(Color.amux.cinnabarDeep)
                }

                Button {
                    Task { await coordinator.createTeam(named: teamName) }
                } label: {
                    HStack {
                        if coordinator.isBusy {
                            ProgressView()
                                .progressViewStyle(.circular)
                                .tint(.white)
                        }
                        Text("Create Team")
                            .fontWeight(.semibold)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                }
                .buttonStyle(.borderedProminent)
                .disabled(coordinator.isBusy)

                Spacer()
            }
            .padding(24)
        }
    }
}

struct OnboardingErrorView: View {
    let message: String
    let onRetry: () -> Void

    var body: some View {
        ContentUnavailableView(
            "Setup Failed",
            systemImage: "exclamationmark.triangle",
            description: Text(message)
        )
        .overlay(alignment: .bottom) {
            Button("Retry") {
                onRetry()
            }
            .buttonStyle(.borderedProminent)
            .padding(.bottom, 48)
        }
    }
}

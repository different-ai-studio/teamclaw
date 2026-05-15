import SwiftUI
import AMUXCore
import AMUXSharedUI

struct WelcomeView: View {
    @Bindable var coordinator: AppOnboardingCoordinator
    @State private var showChoose = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Spacer()

                VStack(spacing: 16) {
                    Image(systemName: "rectangle.3.group")
                        .font(.system(size: 64))
                        .foregroundStyle(Color.amux.cinnabar)
                    // Serif italic for the wordmark — wabi-sabi voice. The
                    // tagline drops to Basalt so the lobster/Cinnabar accent
                    // is the only intentional color on the screen.
                    Text("Teamclaw")
                        .font(.amuxSerif(44, weight: .regular))
                        .foregroundStyle(Color.amux.onyx)
                    Text("Monitor and control your AI coding agents from anywhere.")
                        .font(.body)
                        .foregroundStyle(Color.amux.basalt)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }

                Spacer()

                if let err = coordinator.errorMessage, !err.isEmpty {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(Color.amux.cinnabar)
                        Text(err)
                            .font(.footnote)
                            .foregroundStyle(Color.amux.onyx)
                    }
                    .padding(12)
                    .background(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(Color.amux.pebble)
                    )
                    .padding(.horizontal, 24)
                    .padding(.bottom, 8)
                }

                Button {
                    showChoose = true
                } label: {
                    Text("Get Started")
                        .fontWeight(.semibold)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                }
                .glassProminentButtonStyle()
                .padding(.horizontal, 24)
                .padding(.bottom, 48)
                .accessibilityIdentifier("welcome.getStartedButton")
            }
            .background(Color.amux.mist)
            .navigationDestination(isPresented: $showChoose) {
                ChooseAuthView(coordinator: coordinator)
            }
        }
    }
}

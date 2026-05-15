import SwiftUI

/// Splash shown while `AppOnboardingCoordinator.bootstrap()` runs. Lobster
/// body breathes; both claws wave outward in sync. Replaces the bare
/// `ProgressView("Setting up Teamclaw…")` placeholder.
///
/// The icon is composited from three slices of the TeamClaw logo so the
/// claws can pivot at their wrist anchors independently of the body.
/// Anchor points (0.39 / 0.61, 0.70) were measured from the source 1024×1024
/// asset; tweak there if the logo art is revised.
public struct LobsterSplashView: View {
    @State private var animating = false

    public init() {}

    public var body: some View {
        ZStack {
            Color(.systemBackground).ignoresSafeArea()

            VStack(spacing: 28) {
                lobster.frame(width: 240, height: 240)

                VStack(spacing: 12) {
                    Text("Setting up Teamclaw")
                        .font(.system(.headline, design: .rounded, weight: .medium))
                        .foregroundStyle(.primary)

                    Image(systemName: "ellipsis")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                        .symbolEffect(.variableColor.iterative, options: .repeating)
                }
            }
        }
        .task {
            try? await Task.sleep(for: .milliseconds(80))
            withAnimation(.easeInOut(duration: 0.95).repeatForever(autoreverses: true)) {
                animating = true
            }
        }
    }

    private var lobster: some View {
        ZStack {
            Image("TeamclawBody", bundle: .module)
                .resizable()
                .scaledToFit()
                .scaleEffect(animating ? 1.035 : 1.0)

            Image("TeamclawLeftClaw", bundle: .module)
                .resizable()
                .scaledToFit()
                .rotationEffect(
                    .degrees(animating ? -8 : 0),
                    anchor: UnitPoint(x: 0.39, y: 0.70)
                )

            Image("TeamclawRightClaw", bundle: .module)
                .resizable()
                .scaledToFit()
                .rotationEffect(
                    .degrees(animating ? 8 : 0),
                    anchor: UnitPoint(x: 0.61, y: 0.70)
                )
        }
        .shadow(color: Color(red: 0.93, green: 0.45, blue: 0.40).opacity(0.22), radius: 22, y: 14)
    }
}

#Preview {
    LobsterSplashView()
}

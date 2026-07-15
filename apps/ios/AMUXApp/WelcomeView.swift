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
                    RoleCardsIllustration()
                        .padding(.bottom, 6)

                    Text("Teamclaw")
                        .font(.amuxSerif(44, weight: .regular))
                        .foregroundStyle(Color.amux.onyx)

                    VStack(spacing: 6) {
                        Text("AI digital employees")
                        Text("for every role.")
                    }
                        .font(.body)
                        .foregroundStyle(Color.amux.basalt)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)

                    Text("Your Ally. Together.")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Color.amux.slate)
                        .padding(.top, 2)
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

private struct RoleCardsIllustration: View {
    private let cards: [RoleCard] = [
        .init(title: "Sales", accent: Color.amux.cinnabar, offset: CGSize(width: -40, height: -18)),
        .init(title: "Support", accent: Color.amux.sage, offset: CGSize(width: 42, height: 2)),
        .init(title: "Ops", accent: Color.amux.basalt, offset: CGSize(width: -8, height: 42)),
    ]

    var body: some View {
        ZStack {
            connectionLine

            ForEach(cards) { card in
                RoleCardView(card: card)
                    .offset(card.offset)
            }

            Circle()
                .fill(Color.amux.cinnabar)
                .frame(width: 8, height: 8)
                .offset(x: 72, y: -36)
            Circle()
                .stroke(Color.amux.cinnabar.opacity(0.32), lineWidth: 1)
                .frame(width: 20, height: 20)
                .offset(x: 72, y: -36)
        }
        .frame(width: 236, height: 144)
        .accessibilityHidden(true)
    }

    private var connectionLine: some View {
        Path { path in
            path.move(to: CGPoint(x: 50, y: 42))
            path.addCurve(
                to: CGPoint(x: 172, y: 38),
                control1: CGPoint(x: 82, y: 18),
                control2: CGPoint(x: 136, y: 18)
            )
            path.move(to: CGPoint(x: 70, y: 84))
            path.addCurve(
                to: CGPoint(x: 168, y: 74),
                control1: CGPoint(x: 96, y: 98),
                control2: CGPoint(x: 134, y: 96)
            )
        }
        .stroke(Color.amux.hairline, style: StrokeStyle(lineWidth: 1, dash: [4, 6]))
    }
}

private struct RoleCard: Identifiable {
    let id = UUID()
    let title: String
    let accent: Color
    let offset: CGSize
}

private struct RoleCardView: View {
    let card: RoleCard

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 7) {
                Circle()
                    .fill(card.accent)
                    .frame(width: 9, height: 9)
                Text(card.title)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Color.amux.onyx)
                Spacer(minLength: 0)
            }

            VStack(alignment: .leading, spacing: 5) {
                Capsule()
                    .fill(Color.amux.basalt.opacity(0.32))
                    .frame(width: 62, height: 5)
                Capsule()
                    .fill(Color.amux.slate.opacity(0.28))
                    .frame(width: 42, height: 5)
            }
        }
        .padding(12)
        .frame(width: 104, height: 70)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color.amux.paper)
                .shadow(color: Color.amux.onyx.opacity(0.08), radius: 16, x: 0, y: 10)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Color.amux.hairline, lineWidth: 1)
        )
    }
}

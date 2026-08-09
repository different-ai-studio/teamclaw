import SwiftUI

/// Splash shown while `AppOnboardingCoordinator.bootstrap()` runs.
///
/// Draws the TeamClu mark — "缺口 / The Aperture", a ring broken at the upper
/// right with a coral dot resting in the notch — and animates it once: the dot
/// leaves the notch, travels one lap of the ring, and settles back into it.
///
/// The ring itself never changes. The brand kit also describes a completion
/// state where the ring closes behind the returning dot; that is deliberately
/// not implemented here, because the splash reads better as a mark that stays
/// itself while something loads behind it.
///
/// Vector rather than sliced PNGs. The old lobster splash composited three
/// image slices so its claws could pivot, which bounds the animation to what
/// was sliced in advance; a dot travelling the ring cannot be expressed that
/// way at all. Drawing it keeps the mark sharp at any size and makes the
/// geometry below the brand spec verbatim.
///
/// Geometry is the kit's, against its 120-unit viewBox, scaled to `size`:
///   ring   centre (60,60) · radius 38 · stroke 12 · round caps
///   notch  centred on -45° (upper right), 60° wide
///   dot    radius 9, sitting on the ring line at -45°
public struct ApertureSplashView: View {
    private enum Brand {
        /// #1a1a14 — the ring on light backgrounds.
        static let ink = Color(red: 0.102, green: 0.102, blue: 0.078)
        /// #fdfbf7 — the ring reversed out on dark backgrounds.
        static let cream = Color(red: 0.992, green: 0.984, blue: 0.969)
        /// #e85a4a — the dot. The kit's only accent; do not introduce a third colour.
        static let coral = Color(red: 0.910, green: 0.353, blue: 0.290)
    }

    /// Kit viewBox. Every dimension below is a fraction of this.
    private enum Geometry {
        static let viewBox: CGFloat = 120
        static let ringRadius: CGFloat = 38
        static let strokeWidth: CGFloat = 12
        static let dotRadius: CGFloat = 9
        /// The notch spans 60° of 360°.
        static let gapFraction: CGFloat = 60.0 / 360.0
        /// Notch centre, in SwiftUI's clockwise-from-3-o'clock degrees.
        static let notchCentreDegrees: Double = -45
    }

    /// One unhurried lap. Eased at both ends so the dot leaves and rejoins the
    /// notch rather than starting and stopping dead.
    private static let lapDuration: Double = 2.8

    @Environment(\.colorScheme) private var colorScheme

    private let size: CGFloat
    @State private var dotDegrees: Double = Geometry.notchCentreDegrees

    public init(size: CGFloat = 240) {
        self.size = size
    }

    public var body: some View {
        ZStack {
            Color(.systemBackground).ignoresSafeArea()

            VStack(spacing: 28) {
                aperture.frame(width: size, height: size)

                VStack(spacing: 12) {
                    Text("Setting up TeamClu")
                        .font(.system(.headline, design: .rounded, weight: .medium))
                        .foregroundStyle(.primary)

                    // Carries the "still working" signal once the dot has
                    // parked, so a slow bootstrap never looks frozen.
                    Image(systemName: "ellipsis")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                        .symbolEffect(.variableColor.iterative, options: .repeating)
                }
            }
        }
        .task {
            // Let the first frame land before starting, so the dot is visible
            // at rest in the notch rather than mid-lap on appear.
            try? await Task.sleep(for: .milliseconds(80))
            withAnimation(.easeInOut(duration: Self.lapDuration)) {
                dotDegrees = Geometry.notchCentreDegrees + 360
            }
        }
    }

    private var scale: CGFloat { size / Geometry.viewBox }
    private var ringColor: Color { colorScheme == .dark ? Brand.cream : Brand.ink }

    private var aperture: some View {
        ZStack {
            // The arc: drawn from 0 clockwise, then rotated so the missing 60°
            // sits centred on -45°.
            Circle()
                .trim(from: 0, to: 1 - Geometry.gapFraction)
                .stroke(
                    ringColor,
                    style: StrokeStyle(lineWidth: Geometry.strokeWidth * scale, lineCap: .round)
                )
                .frame(
                    width: Geometry.ringRadius * 2 * scale,
                    height: Geometry.ringRadius * 2 * scale
                )
                .rotationEffect(.degrees(Geometry.notchCentreDegrees + 30))

            // The dot rides the ring line. Parked at 12 o'clock and rotated
            // into place, so one `rotationEffect` drives the whole lap.
            Circle()
                .fill(Brand.coral)
                .frame(
                    width: Geometry.dotRadius * 2 * scale,
                    height: Geometry.dotRadius * 2 * scale
                )
                .offset(y: -Geometry.ringRadius * scale)
                .rotationEffect(.degrees(dotDegrees + 90))
        }
        // Matches the lobster splash's glow at its 240pt size, expressed as a
        // fraction so it tracks `size`.
        .shadow(color: Brand.coral.opacity(0.22), radius: size * 22 / 240, y: size * 14 / 240)
    }
}

#Preview {
    ApertureSplashView()
}

#Preview("Dark") {
    ApertureSplashView()
        .preferredColorScheme(.dark)
}

import SwiftUI

/// Central animation constants for the AMUX iOS app.
///
/// Three tiers:
///   micro    → button press / icon flip (no spring needed, instant feedback)
///   fast     → popup appear, inline expand/collapse
///   standard → panel open/close, mode switches, drawer slide
///
/// Breathing animations always respect `accessibilityReduceMotion`.
public enum AMUXAnimation {
    public static let micro:    Animation = .easeOut(duration: 0.12)
    public static let fast:     Animation = .spring(response: 0.28, dampingFraction: 0.82)
    public static let standard: Animation = .spring(response: 0.38, dampingFraction: 0.86)
    public static let drawer:   Animation = .spring(response: 0.42, dampingFraction: 0.86)

    static let breatheDuration: Double = 1.4
}

// MARK: - Breathing opacity

/// Pulses opacity between 1.0 and `dim` on a gentle easeInOut cycle to
/// signal "active / running" state. Respects `accessibilityReduceMotion`.
public struct BreathingOpacity: ViewModifier {
    let active: Bool
    let dim: Double

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase = false

    public init(active: Bool, dim: Double = 0.35) {
        self.active = active
        self.dim = dim
    }

    public func body(content: Content) -> some View {
        let shouldAnimate = active && !reduceMotion
        return content
            .opacity(shouldAnimate ? (phase ? dim : 1.0) : 1.0)
            .animation(
                shouldAnimate
                    ? .easeInOut(duration: AMUXAnimation.breatheDuration).repeatForever(autoreverses: true)
                    : .default,
                value: phase
            )
            .onAppear { if shouldAnimate { phase = true } }
            .onChange(of: active) { _, nowActive in
                phase = nowActive && !reduceMotion
            }
    }
}

public extension View {
    func breathingOpacity(active: Bool, dim: Double = 0.35) -> some View {
        modifier(BreathingOpacity(active: active, dim: dim))
    }
}

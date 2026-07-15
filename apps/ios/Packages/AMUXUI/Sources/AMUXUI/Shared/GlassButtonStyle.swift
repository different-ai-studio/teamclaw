import SwiftUI

extension View {
    /// Liquid-glass prominent button style on iOS 26+, `.borderedProminent` fallback below.
    ///
    /// Use on body CTAs only. iOS 26's `.toolbar` already wraps each
    /// `ToolbarItem` button in a glass capsule; applying this style there
    /// stacks a second background. For toolbar buttons, use plain icons
    /// (e.g. `Image + .font(.title3) + .buttonStyle(.plain)`) and let the
    /// system wrap.
    @ViewBuilder
    public func glassProminentButtonStyle() -> some View {
        if #available(iOS 26.0, *) {
            self.buttonStyle(.glassProminent)
        } else {
            self.buttonStyle(.borderedProminent)
        }
    }

    /// Liquid-glass button style on iOS 26+, `.bordered` fallback below.
    ///
    /// Same caveat as `glassProminentButtonStyle` — do not use inside
    /// `.toolbar` on iOS 26+.
    @ViewBuilder
    public func glassButtonStyle() -> some View {
        if #available(iOS 26.0, *) {
            self.buttonStyle(.glass)
        } else {
            self.buttonStyle(.bordered)
        }
    }
}

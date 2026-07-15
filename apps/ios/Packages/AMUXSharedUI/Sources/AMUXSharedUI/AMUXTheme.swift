import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// AMUX visual tokens — the **Hai 灰** wabi-sabi palette ratified for v1, with
/// the **Sumi 墨** dark variant from `DESIGN.md`.
///
/// Six tokens drive the entire surface set: five paper/ink neutrals plus a
/// single restrained vermillion accent. The principle is "spare the
/// vermillion" — coral is reserved for the active session dot, the primary
/// CTA, and the unread/permission marker. Everywhere else stays in
/// Mist / Pebble / Slate / Basalt / Onyx.
///
/// Each token is an **adaptive** color: it resolves to its Hai value in light
/// mode and its Sumi value in dark mode via a platform dynamic provider
/// (`UIColor` on iOS, `NSColor` on macOS). Because the resolution happens
/// inside the system color, all `Color.amux.*` call sites pick up dark mode
/// automatically — no per-view `@Environment(\.colorScheme)` branching.
///
/// The tokens are exposed as `Color.amux.*` so call sites read like a
/// design spec rather than a hex bag.
public enum AMUXTheme {
    /// Mist. Primary background. `#F2F0EC` light → `#181513` (night) dark.
    public static let mist        = adaptive(light: 0xF2F0EC, dark: 0x181513)
    /// Paper. Soft card surface. `#F8F6F1` light → `#25221E` (lamp) dark.
    public static let paper       = adaptive(light: 0xF8F6F1, dark: 0x25221E)
    /// Pebble. Secondary surface (chips, dividers, inactive). `#E2DFD9` →
    /// `#3A352F` (stone).
    public static let pebble      = adaptive(light: 0xE2DFD9, dark: 0x3A352F)
    /// Slate. Tertiary text / muted decoration. `#A6A39C` → `#7A7166` (ash).
    public static let slate       = adaptive(light: 0xA6A39C, dark: 0x7A7166)
    /// Basalt. Secondary text / icon stroke. `#5E5B55` → `#CFC8BA` (a dimmed
    /// bone, one step below the Onyx→bone primary so the text hierarchy
    /// survives inversion).
    public static let basalt      = adaptive(light: 0x5E5B55, dark: 0xCFC8BA)
    /// Onyx. Primary text / ink. `#22201D` → `#E8E2D5` (bone).
    public static let onyx        = adaptive(light: 0x22201D, dark: 0xE8E2D5)
    /// Cinnabar. The single accent — active state, primary CTA, unread dot,
    /// permission marker. `#B84B36` → `#D86B53` (ember; "coral becomes an
    /// ember, never a stop sign").
    public static let cinnabar    = adaptive(light: 0xB84B36, dark: 0xD86B53)
    /// Cinnabar deep. Destructive variant. `#8E3A2C` reads as a desaturated,
    /// non-alarming red on both the Mist and the Sumi night ground, so it is
    /// held constant across modes.
    public static let cinnabarDeep = adaptive(light: 0x8E3A2C, dark: 0x8E3A2C)
    /// Sage. Muted "active green" for the breathing dot. `#6B8E5A` light →
    /// `#7FA06B` dark (lifted so it reads against the night ground without
    /// turning alarming).
    public static let sage        = adaptive(light: 0x6B8E5A, dark: 0x7FA06B)

    /// Hairline — ink at low opacity. Use for row separators and quiet card
    /// borders. Light: Onyx @ 10% (warm, matches Mist). Dark: bone @ 10% so
    /// the line lifts off the night ground instead of vanishing into it.
    public static let hairline    = adaptive(light: 0x22201D, dark: 0xE8E2D5, opacity: 0.10)

    /// Build a light/dark adaptive `Color` from two `0xRRGGBB` hex values.
    /// Resolution happens inside a platform dynamic color so the value tracks
    /// the active color scheme at render time.
    static func adaptive(light: UInt, dark: UInt, opacity: Double = 1.0) -> Color {
        #if canImport(UIKit)
        return Color(UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(rgb: hex, alpha: opacity)
        })
        #elseif canImport(AppKit)
        return Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            let hex = isDark ? dark : light
            return NSColor(rgb: hex, alpha: opacity)
        })
        #else
        // Fallback for platforms without a dynamic-color primitive: light only.
        let r = Double((light >> 16) & 0xFF) / 255
        let g = Double((light >> 8) & 0xFF) / 255
        let b = Double(light & 0xFF) / 255
        return Color(red: r, green: g, blue: b).opacity(opacity)
        #endif
    }
}

#if canImport(UIKit)
private extension UIColor {
    convenience init(rgb hex: UInt, alpha: Double) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: CGFloat(alpha)
        )
    }
}
#elseif canImport(AppKit)
private extension NSColor {
    convenience init(rgb hex: UInt, alpha: Double) {
        self.init(
            srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: CGFloat(alpha)
        )
    }
}
#endif

public extension Color {
    /// Namespaced access to the Hai / Sumi palette tokens. Prefer
    /// `Color.amux.cinnabar` over hard-coding hex; each token already adapts
    /// to light/dark, so call sites need no color-scheme branching.
    enum amux {
        public static var mist: Color         { AMUXTheme.mist }
        public static var paper: Color        { AMUXTheme.paper }
        public static var pebble: Color       { AMUXTheme.pebble }
        public static var slate: Color        { AMUXTheme.slate }
        public static var basalt: Color       { AMUXTheme.basalt }
        public static var onyx: Color         { AMUXTheme.onyx }
        public static var cinnabar: Color     { AMUXTheme.cinnabar }
        public static var cinnabarDeep: Color { AMUXTheme.cinnabarDeep }
        public static var sage: Color         { AMUXTheme.sage }
        public static var hairline: Color     { AMUXTheme.hairline }
    }
}

public extension Font {
    /// Editorial serif title for hero copy — matches the design system's
    /// EB Garamond direction using the system serif (New York). For italic
    /// accents combine with `.italic()` at the call site.
    static func amuxSerif(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .serif)
    }
}

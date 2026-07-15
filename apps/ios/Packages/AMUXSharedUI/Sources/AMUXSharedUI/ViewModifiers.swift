import SwiftUI

// MARK: - Liquid Glass View Modifier
//
// Mirrors the same extension defined in AMUXUI/Shared/LiquidGlassBar.swift.
// Duplicated here because AMUXSharedUI cannot import AMUXUI (doing so would
// create a dependency cycle — AMUXUI already depends on AMUXSharedUI).

extension View {
    @ViewBuilder
    func liquidGlass<S: Shape>(
        in shape: S,
        tint: Color? = nil,
        interactive: Bool = true
    ) -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            if interactive {
                if let tint {
                    self.glassEffect(.regular.interactive().tint(tint), in: shape)
                } else {
                    self.glassEffect(.regular.interactive(), in: shape)
                }
            } else {
                if let tint {
                    self.glassEffect(.regular.tint(tint), in: shape)
                } else {
                    self.glassEffect(.regular, in: shape)
                }
            }
        } else {
            self
                .background {
                    shape
                        .fill((tint ?? .gray).opacity(0.14))
                        .background(.ultraThinMaterial, in: shape)
                }
                .shadow(color: .black.opacity(0.08), radius: 10, y: 3)
        }
        #else
        self
            .background {
                shape
                    .fill((tint ?? .gray).opacity(0.14))
                    .background(.ultraThinMaterial, in: shape)
            }
            .shadow(color: .black.opacity(0.08), radius: 10, y: 3)
        #endif
    }
}

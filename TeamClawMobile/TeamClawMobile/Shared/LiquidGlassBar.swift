import SwiftUI

// MARK: - Liquid Glass View Modifier
//
// Apple 在 iOS 26 引入了系统级的 Liquid Glass 效果 (`.glassEffect`).
// 这里提供一个统一入口:
//   * iOS 26+  → 使用系统默认的液态玻璃效果 (.regular.interactive)
//   * iOS 17~25 → 退化到 `.ultraThinMaterial` 近似材质
//
// 使用方式:
//   someView.liquidGlass(in: Capsule())
//   someView.liquidGlass(in: Circle())
//   someView.liquidGlass(in: RoundedRectangle(cornerRadius: 20))

extension View {
    /// 应用系统标准液态玻璃效果，裁剪为指定形状。
    /// - Parameters:
    ///   - shape: 玻璃效果的形状 (Capsule / Circle / RoundedRectangle …)
    ///   - interactive: 是否为可交互元素 (按钮类设为 true, 纯背景设为 false)
    @ViewBuilder
    func liquidGlass<S: Shape>(
        in shape: S,
        interactive: Bool = true
    ) -> some View {
        if #available(iOS 26.0, *) {
            if interactive {
                self.glassEffect(.regular.interactive(), in: shape)
            } else {
                self.glassEffect(.regular, in: shape)
            }
        } else {
            self
                .background {
                    shape
                        .fill(.gray.opacity(0.14))
                        .background(.ultraThinMaterial, in: shape)
                }
                .shadow(color: .black.opacity(0.08), radius: 10, y: 3)
        }
    }
}

// MARK: - LiquidGlassContainer
//
// 在 iOS 26 上等价于 `GlassEffectContainer`, 相邻的液态玻璃元素会
// 自然地融合 / 形变 (例如搜索框展开时和旁边的按钮联动).
// 在旧系统上是一个透传容器.

struct LiquidGlassContainer<Content: View>: View {
    let spacing: CGFloat
    let content: Content

    init(spacing: CGFloat = 10, @ViewBuilder content: () -> Content) {
        self.spacing = spacing
        self.content = content()
    }

    @ViewBuilder
    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) {
                content
            }
        } else {
            content
        }
    }
}

// MARK: - LiquidGlassBar
//
// 通用的底部液态玻璃栏, 供上层自由填充内容.

struct LiquidGlassBar<Content: View>: View {
    let content: () -> Content

    init(@ViewBuilder content: @escaping () -> Content) {
        self.content = content
    }

    var body: some View {
        content()
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .liquidGlass(in: RoundedRectangle(cornerRadius: 20), interactive: false)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
    }
}

#Preview {
    ZStack(alignment: .bottom) {
        Color.blue.opacity(0.1)
            .ignoresSafeArea()

        LiquidGlassBar {
            HStack {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.gray)
                Spacer()
                Image(systemName: "plus.circle.fill")
                    .foregroundStyle(.blue)
            }
        }
    }
}

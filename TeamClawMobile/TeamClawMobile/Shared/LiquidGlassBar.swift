import SwiftUI

struct LiquidGlassBar<Content: View>: View {
    let content: () -> Content

    init(@ViewBuilder content: @escaping () -> Content) {
        self.content = content
    }

    var body: some View {
        content()
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20))
            .shadow(color: .black.opacity(0.08), radius: 8, y: 4)
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

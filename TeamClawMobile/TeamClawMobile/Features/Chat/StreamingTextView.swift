import SwiftUI

struct StreamingTextView: View {
    let content: String

    @State private var cursorVisible = true

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .bottom, spacing: 0) {
                    MarkdownRenderer(content: content)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(cursorVisible ? "█" : " ")
                        .foregroundStyle(.primary.opacity(0.6))
                        .animation(.easeInOut(duration: 0.5).repeatForever(), value: cursorVisible)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(red: 0.94, green: 0.945, blue: 0.961))
            .clipShape(RoundedRectangle(cornerRadius: 16))
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
        .onAppear {
            withAnimation(.easeInOut(duration: 0.5).repeatForever()) {
                cursorVisible.toggle()
            }
        }
    }
}

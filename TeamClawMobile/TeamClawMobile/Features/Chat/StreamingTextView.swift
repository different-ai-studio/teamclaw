import SwiftUI

struct StreamingTextView: View {
    let content: String
    var streamingToolCalls: [ToolCallInfo] = []

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 0) {
                if !content.isEmpty {
                    MarkdownRenderer(content: content)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                }

                ForEach(streamingToolCalls) { tool in
                    ToolCallView(tool: tool)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                }

                // Always at the bottom
                TypingIndicator()
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(red: 0.94, green: 0.945, blue: 0.961))
            .clipShape(RoundedRectangle(cornerRadius: 16))
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
    }
}

// MARK: - Typing Indicator

private struct TypingIndicator: View {
    @State private var phase: CGFloat = 0

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3) { index in
                Circle()
                    .fill(dotColor(for: index))
                    .frame(width: 8, height: 8)
                    .offset(y: dotOffset(for: index))
            }
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) {
                phase = 1
            }
        }
    }

    private func dotColor(for index: Int) -> Color {
        let colors: [Color] = [.blue, .indigo, .purple]
        return colors[index].opacity(dotOpacity(for: index))
    }

    private func dotOffset(for index: Int) -> CGFloat {
        let delay = Double(index) * 0.2
        let value = sin((phase + delay) * .pi)
        return -4 * value
    }

    private func dotOpacity(for index: Int) -> CGFloat {
        let delay = Double(index) * 0.2
        let value = sin((phase + delay) * .pi)
        return 0.5 + 0.5 * value
    }
}

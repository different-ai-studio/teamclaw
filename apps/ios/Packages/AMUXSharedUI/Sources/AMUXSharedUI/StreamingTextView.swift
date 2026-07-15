import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

public struct StreamingTextView: View {
    public let content: String
    @State private var cursorVisible = true

    public init(content: String) {
        self.content = content
    }

    public var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            Text(content)
                .font(.subheadline)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text("▊")
                .font(.subheadline)
                .opacity(cursorVisible ? 1 : 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color.secondary.opacity(0.10), in: RoundedRectangle(cornerRadius: 18))
        .contextMenu {
            Button {
                #if canImport(UIKit)
                UIPasteboard.general.string = content
                #else
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(content, forType: .string)
                #endif
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
            ShareLink(item: content) {
                Label("Share", systemImage: "square.and.arrow.up")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
        .transaction { t in t.animation = nil }
        .onAppear {
            withAnimation(.easeInOut(duration: 0.5).repeatForever(autoreverses: true)) {
                cursorVisible.toggle()
            }
        }
    }
}

import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

public struct JoinURLQRView: View {
    let url: URL

    public init(url: URL) {
        self.url = url
    }

    public var body: some View {
        VStack(spacing: 16) {
            QRCodeView(content: url.absoluteString)
                .frame(width: 220, height: 220)
                .background(Color.white)
                .cornerRadius(12)

            Text(url.absoluteString)
                .font(.system(.caption, design: .monospaced))
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
                .lineLimit(3)

            Button("Copy link") { copy() }
                .buttonStyle(.bordered)
        }
        .padding()
    }

    private func copy() {
        #if canImport(UIKit)
        UIPasteboard.general.string = url.absoluteString
        #elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url.absoluteString, forType: .string)
        #endif
    }
}

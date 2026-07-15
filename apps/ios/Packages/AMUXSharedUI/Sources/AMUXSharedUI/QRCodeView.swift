import SwiftUI
import CoreImage
import CoreImage.CIFilterBuiltins
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Renders an arbitrary string as a QR code. Platform-agnostic;
/// generates via `CIFilter.qrCodeGenerator`.
public struct QRCodeView: View {
    let content: String

    public init(content: String) { self.content = content }

    public var body: some View {
        #if canImport(UIKit)
        if let image = Self.uiImage(content: content) {
            Image(uiImage: image)
                .interpolation(.none)
                .resizable()
                .aspectRatio(1, contentMode: .fit)
        } else {
            Color.gray.opacity(0.2)
        }
        #elseif canImport(AppKit)
        if let image = Self.nsImage(content: content) {
            Image(nsImage: image)
                .interpolation(.none)
                .resizable()
                .aspectRatio(1, contentMode: .fit)
        } else {
            Color.gray.opacity(0.2)
        }
        #else
        Color.gray.opacity(0.2)
        #endif
    }

    #if canImport(UIKit)
    private static func uiImage(content: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(content.utf8)
        guard let ci = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)) else { return nil }
        let context = CIContext()
        guard let cg = context.createCGImage(ci, from: ci.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
    #endif

    #if canImport(AppKit) && !canImport(UIKit)
    private static func nsImage(content: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(content.utf8)
        guard let ci = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)) else { return nil }
        let rep = NSCIImageRep(ciImage: ci)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }
    #endif
}

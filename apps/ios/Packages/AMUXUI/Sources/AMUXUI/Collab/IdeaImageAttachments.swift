import SwiftUI
import AMUXCore
import AMUXSharedUI

#if os(iOS)

/// Horizontal thumbnail row for in-progress idea image attachments. The
/// optional `onAddTapped` slot renders a quiet, dashed `+` tile at the
/// trailing edge so callers can host their own picker / camera flow without
/// duplicating layout. When there are no attachments and no add affordance,
/// the strip renders nothing — leaving the parent layout clean.
struct IdeaImageAttachmentStrip: View {
    let urls: [URL]
    let uploads: [String: AttachmentUpload]
    let onRemove: (URL) -> Void
    var onAddTapped: (() -> Void)? = nil

    var body: some View {
        if !urls.isEmpty || onAddTapped != nil {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(urls, id: \.self) { url in
                        IdeaLocalImageTile(
                            url: url,
                            upload: uploads[url.absoluteString],
                            onRemove: { onRemove(url) }
                        )
                    }
                    if let onAddTapped {
                        IdeaAddImageTile(action: onAddTapped)
                    }
                }
                .padding(.horizontal, 1)
                .padding(.vertical, 2)
            }
        }
    }
}

struct IdeaActivityImageGrid: View {
    let urls: [URL]

    var body: some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 84, maximum: 132), spacing: 8)],
            alignment: .leading,
            spacing: 8
        ) {
            ForEach(urls, id: \.self) { url in
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .scaledToFill()
                    case .failure:
                        ZStack {
                            Color.amux.pebble
                            Image(systemName: "photo.badge.exclamationmark")
                                .foregroundStyle(Color.amux.slate)
                        }
                    case .empty:
                        ZStack {
                            Color.amux.pebble
                            ProgressView().controlSize(.small)
                        }
                    @unknown default:
                        Color.amux.pebble
                    }
                }
                .frame(height: 96)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .stroke(Color.amux.hairline, lineWidth: 0.5)
                )
            }
        }
    }
}

/// Tile size shared by the local-image tile and the add affordance so the
/// strip reads as one row. Slightly larger than the old 58pt thumbnails —
/// the previous size made the remove button feel cramped on the corner.
private let ideaTileSide: CGFloat = 64

private struct IdeaAddImageTile: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color.amux.pebble.opacity(0.45))
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .strokeBorder(
                        Color.amux.basalt.opacity(0.32),
                        style: StrokeStyle(lineWidth: 0.8, dash: [3, 3])
                    )
                Image(systemName: "plus")
                    .font(.system(size: 18, weight: .regular))
                    .foregroundStyle(Color.amux.basalt.opacity(0.75))
            }
            .frame(width: ideaTileSide, height: ideaTileSide)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Add image")
    }
}

private struct IdeaLocalImageTile: View {
    let url: URL
    let upload: AttachmentUpload?
    let onRemove: () -> Void

    @State private var thumbnail: UIImage?

    private var progress: Double { upload?.progress ?? 0 }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            tileBody
                .frame(width: ideaTileSide, height: ideaTileSide)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .stroke(Color.amux.hairline, lineWidth: 0.5)
                )
                .overlay(progressOverlay)

            Button(action: onRemove) {
                ZStack {
                    Circle()
                        .fill(Color.amux.onyx.opacity(0.72))
                        .frame(width: 18, height: 18)
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(Color.amux.mist)
                }
            }
            .buttonStyle(.plain)
            .offset(x: 6, y: -6)
            .accessibilityLabel("Remove image")
        }
        .task(id: url) {
            guard thumbnail == nil else { return }
            thumbnail = await loadThumbnail(from: url)
        }
    }

    @ViewBuilder
    private var tileBody: some View {
        if let thumbnail {
            Image(uiImage: thumbnail)
                .resizable()
                .scaledToFill()
        } else {
            ZStack {
                Color.amux.pebble
                Image(systemName: "photo")
                    .font(.system(size: 18))
                    .foregroundStyle(Color.amux.slate)
            }
        }
    }

    @ViewBuilder
    private var progressOverlay: some View {
        switch upload?.uploadState {
        case .pending, .uploading:
            ZStack {
                Color.amux.onyx.opacity(0.34)
                ProgressView(value: progress)
                    .progressViewStyle(.linear)
                    .tint(Color.amux.mist)
                    .frame(width: 42)
            }
        case .failed:
            ZStack {
                Color.amux.onyx.opacity(0.42)
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Color.amux.cinnabarDeep)
            }
        case .completed, .none:
            EmptyView()
        }
    }

    private func loadThumbnail(from url: URL) async -> UIImage? {
        await Task.detached(priority: .utility) {
            guard let data = try? Data(contentsOf: url),
                  let image = UIImage(data: data) else { return nil }
            let target: CGFloat = 192
            let size = image.size
            let scale = max(target / size.width, target / size.height)
            let newSize = CGSize(width: size.width * scale, height: size.height * scale)
            let renderer = UIGraphicsImageRenderer(size: newSize)
            return renderer.image { _ in
                image.draw(in: CGRect(origin: .zero, size: newSize))
            }
        }.value
    }
}

#endif

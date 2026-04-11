import SwiftUI

struct MessageBubbleView: View {
    let message: ChatMessage
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        switch message.role {
        case .user:
            userBubble
        case .assistant:
            assistantBubble
        case .collaborator:
            collaboratorBubble
        }
    }

    // MARK: - User Bubble

    private var userBubble: some View {
        HStack {
            Spacer()
            VStack(alignment: .trailing, spacing: 6) {
                if let imageURL = message.imageURL, !imageURL.isEmpty {
                    AsyncImage(url: URL(string: imageURL)) { phase in
                        switch phase {
                        case .success(let image):
                            image
                                .resizable()
                                .scaledToFit()
                                .frame(maxWidth: 200, maxHeight: 200)
                                .clipShape(RoundedRectangle(cornerRadius: 12))
                        case .failure:
                            Image(systemName: "photo")
                                .foregroundStyle(.white.opacity(0.7))
                                .frame(width: 80, height: 80)
                        case .empty:
                            ProgressView()
                                .frame(width: 80, height: 80)
                        @unknown default:
                            EmptyView()
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color.blue)
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                }

                if !message.content.isEmpty {
                    Text(message.content)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Color.blue)
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                }
            }
            .frame(maxWidth: sizeClass == .regular ? 500 : 280, alignment: .trailing)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
    }

    // MARK: - Assistant Bubble

    private var assistantBubble: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                let messageParts = message.parts
                if messageParts.isEmpty {
                    MarkdownRenderer(content: message.content)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                } else {
                    ForEach(Array(messageParts.enumerated()), id: \.offset) { _, part in
                        switch part.type {
                        case "text":
                            if let text = part.text, !text.isEmpty {
                                MarkdownRenderer(content: text)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 4)
                            }
                        case "tool":
                            if let tool = part.tool {
                                ToolCallView(tool: tool)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 2)
                            }
                        default:
                            EmptyView()
                        }
                    }
                    .padding(.vertical, 4)
                }

                if message.hasThinking {
                    HStack(spacing: 4) {
                        Image(systemName: "brain")
                            .font(.system(size: 9))
                        Text("有思考过程")
                            .font(.system(size: 9))
                    }
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 6)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(red: 0.94, green: 0.945, blue: 0.961))
            .clipShape(RoundedRectangle(cornerRadius: 16))
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
    }

    // MARK: - Collaborator Bubble

    private var collaboratorBubble: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                if let senderName = message.senderName {
                    Text(senderName)
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(.green)
                        .padding(.horizontal, 12)
                        .padding(.top, 8)
                }
                MarkdownRenderer(content: message.content)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.green.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 16))
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
    }
}

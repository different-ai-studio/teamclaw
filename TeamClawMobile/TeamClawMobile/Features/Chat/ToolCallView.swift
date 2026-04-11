import SwiftUI

struct ToolCallView: View {
    let tool: ToolCallInfo
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.caption2)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .foregroundStyle(.secondary)

                    Image(systemName: toolIcon)
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    Text(displayName)
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundStyle(.primary)

                    if let summary = tool.summary, !isExpanded {
                        Text(summary)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }

                    Spacer()

                    if tool.durationMs > 0 && tool.status != "running" {
                        Text(formatDuration(tool.durationMs))
                            .font(.system(size: 9))
                            .foregroundStyle(.tertiary)
                    }

                    statusIndicator
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
            }
            .buttonStyle(.plain)

            if isExpanded {
                VStack(alignment: .leading, spacing: 8) {
                    if !tool.argumentsJson.isEmpty && tool.argumentsJson != "{}" {
                        detailSection(title: "Arguments", content: formatJSON(tool.argumentsJson))
                    }
                    if !tool.resultSummary.isEmpty {
                        detailSection(title: "Result", content: tool.resultSummary)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.bottom, 8)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .background(Color(.systemGray6))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var toolIcon: String {
        let name = tool.toolName.lowercased()
        if name.contains("write") || name.contains("edit") { return "doc.text" }
        if name.contains("read") { return "doc" }
        if name.contains("bash") || name.contains("shell") || name.contains("terminal") { return "terminal" }
        if name.contains("search") || name.contains("grep") || name.contains("glob") { return "magnifyingglass" }
        if name.contains("task") { return "person.2" }
        if name.contains("web") { return "globe" }
        return "wrench"
    }

    private var displayName: String {
        let name = tool.toolName
        if let range = name.range(of: "__", options: .backwards) {
            return String(name[range.upperBound...])
        }
        return name
    }

    @ViewBuilder
    private var statusIndicator: some View {
        switch tool.status {
        case "running":
            ProgressView()
                .scaleEffect(0.6)
                .frame(width: 14, height: 14)
        case "completed":
            Image(systemName: "checkmark.circle.fill")
                .font(.caption2)
                .foregroundStyle(.green)
        case "failed":
            Image(systemName: "xmark.circle.fill")
                .font(.caption2)
                .foregroundStyle(.red)
        default:
            EmptyView()
        }
    }

    private func detailSection(title: String, content: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.secondary)
            Text(content)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.primary)
                .lineLimit(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(6)
                .background(Color(.systemBackground).opacity(0.6))
                .clipShape(RoundedRectangle(cornerRadius: 4))
        }
    }

    private func formatDuration(_ ms: Int) -> String {
        if ms < 1000 { return "\(ms)ms" }
        return String(format: "%.1fs", Double(ms) / 1000.0)
    }

    private func formatJSON(_ json: String) -> String {
        guard let data = json.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(withJSONObject: obj, options: .prettyPrinted),
              let str = String(data: pretty, encoding: .utf8) else {
            return json
        }
        return str
    }
}

import SwiftUI
import AMUXCore

// MARK: - TodoDockView

/// Sticky bottom dock rendering the latest todo snapshot for the current
/// session. Mounted via `safeAreaInset(.bottom)` on `StreamingDetailView`.
/// Returns an empty view when there are no items so the safe-area inset
/// reserves no space.
public struct TodoDockView: View {
    public let text: String
    @Binding public var isCollapsed: Bool

    public init(text: String, isCollapsed: Binding<Bool>) {
        self.text = text
        self._isCollapsed = isCollapsed
    }

    private var items: [TodoItem] { parseTodoText(text) }
    private var completedCount: Int { items.filter { $0.status == .completed }.count }

    public var body: some View {
        if items.isEmpty {
            EmptyView()
        } else {
            VStack(spacing: 0) {
                header
                if !isCollapsed {
                    list
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                }
            }
            .liquidGlass(in: RoundedRectangle(cornerRadius: 22), interactive: false)
            .padding(.horizontal, 14)
            .padding(.bottom, 8)
            .animation(AMUXAnimation.fast, value: isCollapsed)
        }
    }

    private var header: some View {
        Button {
            isCollapsed.toggle()
        } label: {
            HStack(spacing: 8) {
                Text("TO-DO")
                    .font(.caption)
                    .fontWeight(.semibold)
                    .foregroundStyle(.secondary)
                Text("·  \(completedCount) / \(items.count)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(isCollapsed ? 0 : 180))
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var list: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .top, spacing: 8) {
                        Text("\(index + 1).")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .frame(width: 20, alignment: .trailing)
                        Image(systemName: item.status.rowIcon)
                            .font(.caption)
                            .foregroundStyle(item.status.rowColor)
                            .padding(.top, 3)
                        Text(item.content)
                            .font(.subheadline)
                            .strikethrough(item.status == .completed)
                            .foregroundStyle(item.status == .completed ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 10)
        }
        .frame(maxHeight: 175)
    }

}

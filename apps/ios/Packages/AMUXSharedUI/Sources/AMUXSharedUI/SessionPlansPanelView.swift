import SwiftUI
import AMUXCore

/// Top-anchored liquid-glass panel showing the live plan_update snapshot
/// for each agent in the current session that still has unfinished
/// items. Multiple agents swipe horizontally via TabView's page style.
/// Mounted by `SessionDetailView` via `safeAreaInset(edge: .top)` so the
/// scroll content respects the panel's height instead of disappearing
/// behind it.
public struct SessionPlansPanelView: View {
    public let snapshots: [AgentPlanSnapshot]
    @Binding public var pageIndex: Int

    public init(snapshots: [AgentPlanSnapshot], pageIndex: Binding<Int>) {
        self.snapshots = snapshots
        self._pageIndex = pageIndex
    }

    public var body: some View {
        TabView(selection: $pageIndex) {
            ForEach(Array(snapshots.enumerated()), id: \.element.id) { idx, snapshot in
                SessionPlansPage(snapshot: snapshot).tag(idx)
            }
        }
        #if os(iOS)
        .tabViewStyle(.page(indexDisplayMode: snapshots.count > 1 ? .always : .never))
        #endif
        .frame(height: 205)
        .background {
            RoundedRectangle(cornerRadius: 22)
                .fill(Color.amux.paper.opacity(0.94))
                .overlay {
                    RoundedRectangle(cornerRadius: 22)
                        .stroke(Color.amux.hairline, lineWidth: 0.5)
                }
        }
        .padding(.horizontal, 14)
        .padding(.top, 6)
        .padding(.bottom, 6)
        .transition(.move(edge: .top).combined(with: .opacity))
        .onChange(of: snapshots.count) { _, newCount in
            // Keep the page binding in range when an agent's plan
            // completes and its page disappears.
            if pageIndex >= newCount {
                pageIndex = max(0, newCount - 1)
            }
        }
    }
}

private struct SessionPlansPage: View {
    let snapshot: AgentPlanSnapshot

    private var completedCount: Int {
        snapshot.items.filter { $0.status == .completed }.count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("\(snapshot.agentName) — Plans")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text("\(completedCount) / \(snapshot.items.count)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(snapshot.items.enumerated()), id: \.offset) { index, item in
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
                                .lineLimit(2)
                                .strikethrough(item.status == .completed)
                                .foregroundStyle(
                                    item.status == .completed
                                        ? AnyShapeStyle(.secondary)
                                        : AnyShapeStyle(.primary)
                                )
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
                .padding(.bottom, 18) // leave room for the page dots
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
    }

}

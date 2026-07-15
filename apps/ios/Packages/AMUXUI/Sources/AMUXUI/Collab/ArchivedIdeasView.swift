import SwiftUI
import AMUXCore
import AMUXSharedUI

struct ArchivedIdeasView: View {
    @Environment(\.dismiss) private var dismiss

    @Bindable var ideaStore: IdeaStore

    var body: some View {
        NavigationStack {
            Group {
                if ideaStore.archivedIdeas.isEmpty {
                    ContentUnavailableView(
                        "Nothing Archived",
                        systemImage: "archivebox",
                        description: Text("Archived ideas will show up here.")
                    )
                } else {
                    List {
                        ForEach(ideaStore.archivedIdeas) { item in
                            IdeaRow(item: item)
                                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                    Button {
                                        Task { await ideaStore.setArchived(ideaID: item.id, archived: false) }
                                    } label: {
                                        Label("Unarchive", systemImage: "tray.and.arrow.up")
                                    }
                                    .tint(Color.amux.cinnabar)
                                }
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Archived")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark").font(.title3)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

import SwiftUI
import SwiftData
import AMUXCore
import AMUXSharedUI

public struct IdeaListView: View {
    @Bindable var ideaStore: IdeaStore

    @Query(filter: #Predicate<CachedActor> { $0.actorType == "member" },
           sort: \CachedActor.displayName)
    private var members: [CachedActor]

    @Query(sort: \Workspace.displayName) private var workspaces: [Workspace]

    private var memberById: [String: CachedActor] {
        Dictionary(uniqueKeysWithValues: members.map { ($0.actorId, $0) })
    }

    private var workspaceNameById: [String: String] {
        Dictionary(uniqueKeysWithValues: workspaces.map { ($0.workspaceId, $0.displayName) })
    }

    @Binding var showCreate: Bool
    @Binding var navigationPath: [String]
    @State private var showArchived = false
    @State private var filter: Filter = .all
    @State private var editMode: EditMode = .inactive

    /// `Mine` compares against `IdeaRecord.createdByActorID`. `nil` hides
    /// the "Mine" chip from the filter bar (the user hasn't been mapped
    /// to a Supabase actor yet — happens on cold boot before the team
    /// loads).
    let currentActorID: String?

    public init(
        ideaStore: IdeaStore,
        showCreate: Binding<Bool>,
        navigationPath: Binding<[String]>,
        currentActorID: String? = nil
    ) {
        self.ideaStore = ideaStore
        self._showCreate = showCreate
        self._navigationPath = navigationPath
        self.currentActorID = currentActorID
    }

    enum Filter: Hashable {
        case all, mine, open, done
    }

    /// Source ideas — already filtered to `archived == false` by the store.
    /// We keep the original order (most-recently-updated first) and slice
    /// per the segment selection.
    private var filteredIdeas: [IdeaRecord] {
        switch filter {
        case .all:  return ideaStore.ideas
        case .mine:
            guard let me = currentActorID, !me.isEmpty else { return [] }
            return ideaStore.ideas.filter { $0.createdByActorID == me }
        case .open: return ideaStore.ideas.filter { $0.status == "open" }
        case .done: return ideaStore.ideas.filter { $0.status == "done" }
        }
    }

    private var filterSegments: [SegmentedFilterBar<Filter>.Segment] {
        var segments: [SegmentedFilterBar<Filter>.Segment] = [
            .init(tag: .all, title: "All", count: ideaStore.ideas.count)
        ]
        if let me = currentActorID, !me.isEmpty {
            let mineCount = ideaStore.ideas.filter { $0.createdByActorID == me }.count
            segments.append(.init(tag: .mine, title: "Mine", count: mineCount))
        }
        segments.append(.init(
            tag: .open,
            title: "Open",
            count: ideaStore.ideas.filter { $0.status == "open" }.count
        ))
        segments.append(.init(
            tag: .done,
            title: "Done",
            count: ideaStore.ideas.filter { $0.status == "done" }.count
        ))
        return segments
    }

    public var body: some View {
        VStack(spacing: 0) {
            if let errorMessage = ideaStore.errorMessage, ideaStore.ideas.isEmpty, !ideaStore.isLoading {
                ContentUnavailableView(
                    "Couldn’t Load Ideas",
                    systemImage: "exclamationmark.triangle",
                    description: Text(errorMessage)
                )
            } else if ideaStore.isLoading && ideaStore.ideas.isEmpty {
                ProgressView("Loading ideas…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if ideaStore.ideas.isEmpty {
                ContentUnavailableView(
                    "No Ideas",
                    systemImage: IdeaUIPresentation.systemImage,
                    description: Text("Tap + to create an idea")
                )
            } else {
                List {
                    Section {
                        SegmentedFilterBar(segments: filterSegments, selection: $filter)
                            .padding(.horizontal, 16)
                            .padding(.top, 4)
                            .padding(.bottom, 12)
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                            .listRowInsets(EdgeInsets())
                    }

                    if filteredIdeas.isEmpty {
                        emptyFilterRow
                    } else {
                        ForEach(filteredIdeas) { item in
                            Button {
                                navigationPath.append("idea:\(item.id)")
                            } label: {
                                IdeaRow(
                                    item: item,
                                    creator: memberById[item.createdByActorID],
                                    workspaceName: workspaceNameById[item.workspaceID]
                                )
                            }
                            .buttonStyle(.plain)
                            .listRowBackground(Color.clear)
                            .listRowSeparatorTint(Color.amux.hairline)
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                Button {
                                    Task { await ideaStore.setArchived(ideaID: item.id, archived: true) }
                                } label: {
                                    Label("Archive", systemImage: "archivebox.fill")
                                }
                                .tint(.gray)
                            }
                        }
                        .onMove(perform: ideaStore.moveIdeas)
                        .moveDisabled(filter != .all)
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .environment(\.editMode, $editMode)
                .refreshable {
                    await ideaStore.reload()
                }
            }
        }
        .background(Color.amux.mist)
        .navigationTitle(IdeaUIPresentation.pluralTitle)
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            if filter == .all, filteredIdeas.count > 1 {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        withAnimation(.easeInOut(duration: 0.16)) {
                            editMode = editMode.isEditing ? .inactive : .active
                        }
                    } label: {
                        Image(systemName: editMode.isEditing ? "checkmark" : "arrow.up.arrow.down")
                            .font(.title3)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.primary)
                    .accessibilityLabel(editMode.isEditing ? "Done sorting" : "Sort ideas")
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if !ideaStore.archivedIdeas.isEmpty {
                Button {
                    showArchived = true
                } label: {
                    HStack {
                        Image(systemName: "archivebox")
                        Text("Archived (\(ideaStore.archivedIdeas.count))")
                        Spacer()
                    }
                    .font(.body)
                    .foregroundStyle(.primary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .padding(.horizontal, 16)
                }
                .buttonStyle(.plain)
            }
        }
        .sheet(isPresented: $showCreate) {
            CreateIdeaSheet(ideaStore: ideaStore) { }
        }
        .sheet(isPresented: $showArchived) {
            ArchivedIdeasView(ideaStore: ideaStore)
        }
        .onChange(of: filter) { _, newValue in
            if newValue != .all {
                editMode = .inactive
            }
        }
    }

    private var emptyFilterRow: some View {
        VStack(spacing: 6) {
            Text(emptyFilterTitle)
                .font(.subheadline)
                .fontWeight(.medium)
                .foregroundStyle(Color.amux.basalt)
            Text(emptyFilterSubtitle)
                .font(.footnote)
                .foregroundStyle(Color.amux.slate)
        }
        .frame(maxWidth: .infinity, minHeight: 180)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }

    private var emptyFilterTitle: String {
        switch filter {
        case .all:  return "No Ideas"
        case .mine: return "Nothing here yet"
        case .open: return "No open ideas"
        case .done: return "No completed ideas"
        }
    }

    private var emptyFilterSubtitle: String {
        switch filter {
        case .all:  return "Tap + to create an idea"
        case .mine: return "Ideas you create will show up here"
        case .open: return "Open ideas will appear once created"
        case .done: return "Mark an idea as Done to see it here"
        }
    }
}

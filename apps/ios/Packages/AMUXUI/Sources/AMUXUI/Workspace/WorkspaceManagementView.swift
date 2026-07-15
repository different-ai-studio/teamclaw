import SwiftUI
import AMUXSharedUI
import SwiftData
import AMUXCore

/// Pushable workspace list + add/remove UI. No NavigationStack, no sheet.
/// Parent provides navigation context.
public struct WorkspaceManagementView: View {
    @Environment(\.modelContext) private var modelContext

    let viewModel: SessionListViewModel
    let teamclawService: TeamclawService
    let targetActorID: String

    @State private var newPath = ""
    @State private var errorMessage: String?
    @State private var isAdding = false

    private var workspaces: [Workspace] { viewModel.workspaces }

    public init(viewModel: SessionListViewModel, teamclawService: TeamclawService, targetActorID: String) {
        self.viewModel = viewModel
        self.teamclawService = teamclawService
        self.targetActorID = targetActorID
    }

    public var body: some View {
        VStack(spacing: 0) {
            if workspaces.isEmpty {
                ContentUnavailableView("No Workspaces", systemImage: "folder",
                    description: Text("Add a directory to get started"))
            } else {
                List {
                    ForEach(workspaces, id: \.workspaceId) { ws in
                        Button {
                            newPath = ws.path
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(ws.displayName).font(.body).fontWeight(.medium)
                                Text(ws.path).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .buttonStyle(.plain)
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            Button(role: .destructive) {
                                removeWorkspace(ws.workspaceId)
                            } label: {
                                Label("Remove", systemImage: "trash")
                            }
                        }
                    }
                }
                .listStyle(.plain)
            }

            Spacer(minLength: 0)

            if let errorMessage {
                Text(errorMessage)
                    .font(.caption).foregroundStyle(Color.amux.cinnabarDeep)
                    .padding(.horizontal, 16).padding(.bottom, 4)
            }

            HStack(spacing: 8) {
                TextField("Directory path (e.g. /Users/me/project)", text: $newPath)
                    .font(.subheadline)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .liquidGlass(in: Capsule())

                if !newPath.trimmingCharacters(in: .whitespaces).isEmpty {
                    Button { addWorkspace() } label: {
                        if isAdding {
                            ProgressView()
                                .controlSize(.regular)
                                .frame(width: 28, height: 28)
                        } else {
                            Image(systemName: "plus.circle.fill")
                                .font(.title2)
                                .symbolRenderingMode(.hierarchical)
                        }
                    }
                    .disabled(isAdding)
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
        }
        .navigationTitle("Workspaces")
        .navigationBarTitleDisplayMode(.large)
    }

    private func addWorkspace() {
        let path = newPath.trimmingCharacters(in: .whitespaces)
        guard !path.isEmpty else { return }

        isAdding = true
        errorMessage = nil

        let target = targetActorID
        Task {
            let (ok, err) = await teamclawService.addWorkspaceRpc(targetActorID: target, path: path)
            await MainActor.run {
                isAdding = false
                if ok {
                    newPath = ""
                    errorMessage = nil
                } else {
                    errorMessage = err.isEmpty ? "Add failed" : err
                }
            }
        }
    }

    private func removeWorkspace(_ workspaceId: String) {
        let target = targetActorID
        Task {
            let (ok, err) = await teamclawService.removeWorkspaceRpc(targetActorID: target, workspaceId: workspaceId)
            if !ok {
                await MainActor.run {
                    errorMessage = err.isEmpty ? "Remove failed" : err
                }
            }
        }
    }
}

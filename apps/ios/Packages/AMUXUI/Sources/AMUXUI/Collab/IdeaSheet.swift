import SwiftUI
import SwiftData
import PhotosUI
import AMUXCore
import AMUXSharedUI

#if os(iOS)

public struct IdeaSheet: View {
    @Environment(\.dismiss) private var dismiss

    let pairing: PairingManager
    let teamclawService: TeamclawService?

    public init(pairing: PairingManager, teamclawService: TeamclawService? = nil) {
        self.pairing = pairing
        self.teamclawService = teamclawService
    }

    public var body: some View {
        NavigationStack {
            ContentUnavailableView(
                "Ideas Live In The Ideas Tab",
                systemImage: IdeaUIPresentation.systemImage,
                description: Text("Use the dedicated Ideas tab for Supabase-backed idea management.")
            )
            .navigationTitle(IdeaUIPresentation.pluralTitle)
            .navigationBarTitleDisplayMode(.large)
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

/// Hai-styled "New Idea" sheet. Mirrors the prototype: Pebble surface,
/// icon-only liquid-glass toolbar actions, large editorial title field
/// with a description textarea stacked underneath in a single Paper card,
/// followed by a Workspace section card.
enum CreateIdeaSheetToolbarPresentation {
    static let cancelSystemImage = "xmark"
    static let submitSystemImage = "checkmark"
    static let cancelAccessibilityLabel = "Cancel"
    static let submitAccessibilityLabel = "Post"
}

struct CreateIdeaSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Environment(AppOnboardingCoordinator.self) private var coordinator: AppOnboardingCoordinator?

    @Bindable var ideaStore: IdeaStore
    let onCreated: () -> Void

    @State private var title = ""
    @State private var description = ""
    @State private var isSaving = false
    @State private var imageAttachments: [URL] = []
    @State private var imageUploads: [String: AttachmentUpload] = [:]
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showCamera = false
    @State private var showPhotoPicker = false
    @State private var showImageSourceDialog = false
    @State private var uploadManager: AttachmentUploadManager?
    @State private var draftAttachmentContextID = "idea-draft-\(UUID().uuidString)"
    @FocusState private var titleFocused: Bool

    private var canSave: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !isSaving
            && !hasUploadingImageAttachments
            && !hasFailedImageAttachments
    }

    private var teamName: String {
        coordinator?.currentContext?.team.name ?? "this team"
    }

    private var teamID: String {
        coordinator?.currentContext?.team.id ?? ""
    }

    private var hasUploadingImageAttachments: Bool {
        imageUploads.values.contains { $0.uploadState == .pending || $0.uploadState == .uploading }
    }

    private var hasFailedImageAttachments: Bool {
        imageUploads.values.contains { $0.uploadState == .failed }
    }

    private var uploadedImageURLs: [URL] {
        imageAttachments.compactMap { localURL in
            imageUploads[localURL.absoluteString]?.storageURL.flatMap(URL.init(string:))
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    composerCard
                    imageSection
                    if let errorMessage = ideaStore.errorMessage {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(Color.amux.cinnabarDeep)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 24)
                    }
                    footerCaption
                }
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .scrollContentBackground(.hidden)
            .background(Color.amux.mist)
            .navigationTitle("New Idea")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button { dismiss() } label: {
                        Image(systemName: CreateIdeaSheetToolbarPresentation.cancelSystemImage)
                            .font(.title3)
                            .foregroundStyle(.primary)
                    }
                    .accessibilityLabel(CreateIdeaSheetToolbarPresentation.cancelAccessibilityLabel)
                    .buttonStyle(.plain)
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        save()
                    } label: {
                        if isSaving {
                            ProgressView()
                        } else {
                            Image(systemName: CreateIdeaSheetToolbarPresentation.submitSystemImage)
                                .font(.title3)
                                .foregroundStyle(canSave ? Color.amux.cinnabar : Color.amux.slate.opacity(0.5))
                        }
                    }
                    .accessibilityLabel(CreateIdeaSheetToolbarPresentation.submitAccessibilityLabel)
                    .buttonStyle(.plain)
                    .disabled(!canSave)
                }
            }
        }
        .presentationDragIndicator(.visible)
        .onAppear { titleFocused = true }
        .fullScreenCover(isPresented: $showCamera) {
            CameraImagePicker(
                onCapture: { url in
                    Task {
                        await addImageAttachment(url)
                        showCamera = false
                    }
                },
                onCancel: { showCamera = false }
            )
            .ignoresSafeArea()
        }
        .photosPicker(
            isPresented: $showPhotoPicker,
            selection: $photoItems,
            maxSelectionCount: 5,
            matching: .images
        )
        .confirmationDialog(
            "Add image",
            isPresented: $showImageSourceDialog,
            titleVisibility: .hidden
        ) {
            Button("Photo Library") { showPhotoPicker = true }
            Button("Camera") { showCamera = true }
            Button("Cancel", role: .cancel) {}
        }
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            Task {
                for item in items {
                    guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
                    let url = FileManager.default.temporaryDirectory
                        .appendingPathComponent("idea-photo-\(UUID().uuidString).jpg")
                    try? data.write(to: url)
                    await addImageAttachment(url)
                }
                photoItems = []
            }
        }
    }

    private var composerCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Idea title", text: $title, axis: .vertical)
                .focused($titleFocused)
                .font(.system(size: 22, weight: .bold))
                .foregroundStyle(Color.amux.onyx)
                .lineLimit(1...3)

            TextField(
                "Add context — what's the constraint, what's the win?",
                text: $description,
                axis: .vertical
            )
            .font(.system(size: 15))
            .foregroundStyle(Color.amux.basalt)
            .lineLimit(3...10)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.amux.paper)
        )
        .padding(.horizontal, 16)
    }

    /// Image attachments live as a quiet thumbnail strip — no section
    /// label, no paper card. Tap the trailing dashed `+` tile to pick a
    /// source. The strip itself only renders when there's something to
    /// show (either an image or the add tile), so an empty composer has
    /// no visual weight.
    private var imageSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            IdeaImageAttachmentStrip(
                urls: imageAttachments,
                uploads: imageUploads,
                onRemove: removeImageAttachment,
                onAddTapped: { showImageSourceDialog = true }
            )

            if hasFailedImageAttachments {
                Text("One image failed to upload. Remove it and try again.")
                    .font(.caption)
                    .foregroundStyle(Color.amux.cinnabarDeep)
            }
        }
        .padding(.horizontal, 16)
    }

    private var footerCaption: some View {
        Text(.init(
            "Posted to **Team · \(teamName)**. Anyone can submit progress."
        ))
        .font(.system(size: 12))
        .foregroundStyle(Color.amux.basalt.opacity(0.75))
        .padding(.horizontal, 24)
        .padding(.top, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func save() {
        guard !isSaving, canSave else { return }
        isSaving = true
        Task {
            let knownIdeaIDs = Set((ideaStore.ideas + ideaStore.archivedIdeas).map(\.id))
            let ok = await ideaStore.createIdea(
                title: title,
                description: description,
                workspaceID: ""
            )
            if ok, !uploadedImageURLs.isEmpty {
                let created = ideaStore.ideas.first { !knownIdeaIDs.contains($0.id) } ?? ideaStore.ideas.first
                if let created {
                    _ = await ideaStore.createActivity(
                        ideaID: created.id,
                        activityType: "progress",
                        content: "Attached \(uploadedImageURLs.count) image\(uploadedImageURLs.count == 1 ? "" : "s").",
                        attachmentURLs: uploadedImageURLs
                    )
                }
            }
            isSaving = false
            if ok {
                onCreated()
                dismiss()
            }
        }
    }

    private func addImageAttachment(_ url: URL) async {
        guard !imageAttachments.contains(url) else { return }
        guard let manager = ensureUploadManager() else {
            ideaStore.errorMessage = "Image upload is unavailable for this team."
            return
        }
        imageAttachments.append(url)
        do {
            let upload = try await manager.startUpload(
                filePath: url,
                messageID: draftAttachmentContextID,
                sessionID: "ideas/\(draftAttachmentContextID)",
                teamID: teamID
            )
            imageUploads[url.absoluteString] = upload
        } catch {
            ideaStore.errorMessage = error.localizedDescription
        }
    }

    private func removeImageAttachment(_ url: URL) {
        imageAttachments.removeAll { $0 == url }
        imageUploads.removeValue(forKey: url.absoluteString)
    }

    private func ensureUploadManager() -> AttachmentUploadManager? {
        guard !teamID.isEmpty else { return nil }
        if let uploadManager { return uploadManager }
        guard let manager = try? AttachmentUploadManager.fromMainBundle(modelContext: modelContext) else {
            return nil
        }
        uploadManager = manager
        return manager
    }
}

struct EditIdeaSheet: View {
    @Environment(\.dismiss) private var dismiss

    @Bindable var ideaStore: IdeaStore
    let idea: IdeaRecord

    @State private var title: String
    @State private var description: String
    @State private var status: String
    @State private var isSaving = false

    init(ideaStore: IdeaStore, idea: IdeaRecord) {
        self.ideaStore = ideaStore
        self.idea = idea
        _title = State(initialValue: idea.title)
        _description = State(initialValue: idea.description)
        _status = State(initialValue: idea.status)
    }

    private var canSave: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !isSaving
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Title") {
                    TextField("Idea title", text: $title, axis: .vertical)
                        .lineLimit(2...5)
                }

                Section("Description") {
                    TextField("Optional context", text: $description, axis: .vertical)
                        .lineLimit(4...8)
                }

                Section("Status") {
                    Picker("Status", selection: $status) {
                        Text("Open").tag("open")
                        Text("In Progress").tag("in_progress")
                        Text("Done").tag("done")
                    }
                    .pickerStyle(.segmented)
                }

                if let errorMessage = ideaStore.errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(Color.amux.cinnabarDeep)
                    }
                }
            }
            .navigationTitle("Edit Idea")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                    }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        save()
                    } label: {
                        if isSaving {
                            ProgressView()
                        } else {
                            Image(systemName: "checkmark")
                        }
                    }
                    .disabled(!canSave)
                }
            }
        }
    }

    private func save() {
        guard !isSaving else { return }
        isSaving = true
        Task {
            let ok = await ideaStore.updateIdea(
                ideaID: idea.id,
                title: title,
                description: description,
                status: status,
                workspaceID: idea.workspaceID
            )
            isSaving = false
            if ok {
                dismiss()
            }
        }
    }
}

struct IdeaRow: View {
    let item: IdeaRecord
    var creator: CachedActor?
    var workspaceName: String?

    init(item: IdeaRecord, creator: CachedActor? = nil, workspaceName: String? = nil) {
        self.item = item
        self.creator = creator
        self.workspaceName = workspaceName
    }

    init(item: SessionIdea, creator: CachedActor? = nil, workspaceName: String? = nil) {
        self.item = IdeaRecord(
            id: item.ideaId,
            teamID: "",
            workspaceID: item.workspaceId,
            createdByActorID: item.createdBy,
            title: item.title,
            description: item.ideaDescription,
            status: item.status,
            archived: item.archived,
            sortOrder: item.sortOrder,
            createdAt: item.createdAt,
            updatedAt: item.createdAt
        )
        self.creator = creator
        self.workspaceName = workspaceName
    }

    private var pillForeground: Color {
        if item.isDone       { return Color.amux.sage }
        if item.isInProgress { return Color.amux.basalt }
        return Color.amux.cinnabar
    }

    private var creatorInitial: String {
        guard let name = creator?.displayName, let first = name.first else { return "·" }
        return String(first).uppercased()
    }

    /// All creator avatars sit in Hai grays — the previous rainbow palette
    /// is gone. Cinnabar is reserved for the active session, not for
    /// decorating creator chips.
    private var creatorAvatarColor: Color {
        guard let id = creator?.actorId, !id.isEmpty else { return Color.amux.slate }
        let palette: [Color] = [Color.amux.basalt, Color.amux.slate]
        let hash = id.unicodeScalars.reduce(0) { $0 &+ Int($1.value) }
        return palette[abs(hash) % palette.count]
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack {
                statusGlyph
                    .foregroundStyle(pillForeground)
                    .frame(width: 14, height: 14)
                Spacer(minLength: 0)
            }
            .padding(.top, 4)

            VStack(alignment: .leading, spacing: 6) {
                Text(item.displayTitle)
                    .font(.body)
                    .foregroundStyle(item.isDone ? .secondary : .primary)
                    .strikethrough(item.isDone, color: .secondary)
                    .lineLimit(2)

                creatorFooter(creator, updatedAt: item.updatedAt)
            }
        }
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private var statusGlyph: some View {
        if item.isDone {
            Image(systemName: "checkmark")
                .font(.system(size: 9, weight: .heavy))
        } else if item.isInProgress {
            ZStack {
                Circle()
                    .stroke(pillForeground.opacity(0.35), lineWidth: 1.4)
                Circle()
                    .trim(from: 0, to: 0.6)
                    .stroke(pillForeground, style: StrokeStyle(lineWidth: 1.8, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            .frame(width: 8, height: 8)
        } else {
            Circle()
                .strokeBorder(pillForeground, lineWidth: 1.5)
                .frame(width: 8, height: 8)
        }
    }

    private func creatorFooter(_ creator: CachedActor?, updatedAt: Date) -> some View {
        let name = creator?.displayName.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return HStack(spacing: 6) {
            ZStack {
                Circle().fill(creatorAvatarColor)
                Text(creatorInitial)
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.white)
            }
            .frame(width: 18, height: 18)
            Text(name.isEmpty ? "Unknown" : name)
                .font(.caption)
                .foregroundStyle(.primary)
                .lineLimit(1)
            Spacer(minLength: 8)
            Text(updatedAt.amuxRelativeAbbreviated)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
        }
        .padding(.top, 2)
    }
}

private extension Date {
    var amuxRelativeAbbreviated: String {
        let seconds = max(0, Int(Date().timeIntervalSince(self)))
        if seconds < 60 { return "now" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h" }
        let days = hours / 24
        if days < 7 { return "\(days)d" }
        let weeks = days / 7
        if weeks < 8 { return "\(weeks)w" }
        let months = days / 30
        if months < 12 { return "\(months)mo" }
        return "\(days / 365)y"
    }
}
#else
public struct IdeaSheet: View {
    public init(pairing: PairingManager, teamclawService: TeamclawService? = nil) {}

    public var body: some View {
        ContentUnavailableView("Ideas", systemImage: IdeaUIPresentation.systemImage)
    }
}

struct CreateIdeaSheet: View {
    @Bindable var ideaStore: IdeaStore
    let onCreated: () -> Void

    var body: some View {
        ContentUnavailableView("New Idea", systemImage: "plus")
    }
}

struct EditIdeaSheet: View {
    @Bindable var ideaStore: IdeaStore
    let idea: IdeaRecord

    var body: some View {
        ContentUnavailableView("Edit Idea", systemImage: "pencil")
    }
}

struct IdeaRow: View {
    let item: IdeaRecord
    var creatorName: String? = nil

    var body: some View {
        Text(item.displayTitle)
    }
}
#endif

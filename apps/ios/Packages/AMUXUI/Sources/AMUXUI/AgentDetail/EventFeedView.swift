import SwiftUI
import SwiftData
import AMUXCore
import AMUXSharedUI

// MARK: - CachedActorMap

/// Lightweight snapshot of actorID → displayName, built once at the parent
/// from a single `@Query` and passed down so each bubble doesn't register
/// its own SwiftData observation. With 100 visible bubbles the old approach
/// caused 100 separate re-renders on every CachedActor change.
public struct CachedActorMap: Sendable {
    public static let empty = CachedActorMap(nameByActorID: [:])
    public let nameByActorID: [String: String]
    public init(nameByActorID: [String: String]) { self.nameByActorID = nameByActorID }
    public func displayName(for actorID: String) -> String? { nameByActorID[actorID] }
}

// MARK: - EventBubbleView

public struct EventBubbleView: View {
    let event: AgentEvent
    let runtime: Runtime?
    let onGrant: ((String, String?) -> Void)?
    let onDeny: ((String, String?) -> Void)?
    /// Tap handler invoked when the user taps a `.failed` outbox dot on
    /// their own bubble. Hooked to `OutboxSender.retry` by the parent.
    let onRetryOutbox: ((String) -> Void)?
    /// When false the assistant bubble suppresses its "{Agent} · {Model}"
    /// caption. Used by `StreamingDetailView`, where the same identity is
    /// already painted into the nav-bar title for the whole turn so the
    /// per-bubble caption would just be redundant.
    let showsAssistantHeader: Bool
    /// Actor map built by the parent once per recomputeGroups cycle.
    /// Replaces the per-row @Query(CachedActor) so ~100 bubbles don't
    /// each register a SwiftData observation.
    let actorMap: CachedActorMap
    /// Context-menu hooks for the user's own persisted prompts. The parent
    /// decides eligibility (own message + supabaseMessageId present) and
    /// passes nil otherwise, so the bubble never has to reason about
    /// identity or persistence state itself.
    let onEdit: (() -> Void)?
    let onDelete: (() -> Void)?

    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var fullscreenImageContext: FullscreenImageContext?

    public init(event: AgentEvent, runtime: Runtime? = nil,
                onGrant: ((String, String?) -> Void)? = nil,
                onDeny: ((String, String?) -> Void)? = nil,
                onRetryOutbox: ((String) -> Void)? = nil,
                showsAssistantHeader: Bool = true,
                actorMap: CachedActorMap = .empty,
                onEdit: (() -> Void)? = nil,
                onDelete: (() -> Void)? = nil) {
        self.event = event
        self.runtime = runtime
        self.onGrant = onGrant
        self.onDeny = onDeny
        self.onRetryOutbox = onRetryOutbox
        self.showsAssistantHeader = showsAssistantHeader
        self.actorMap = actorMap
        self.onEdit = onEdit
        self.onDelete = onDelete
    }

    /// True when this event was produced by an actor other than the
    /// signed-in user. Drives the "You / @other" label and bubble alignment
    /// for user-prompt rows.
    private var isFromOtherUser: Bool {
        guard let senderID = event.senderActorID, !senderID.isEmpty else { return false }
        return senderID != currentActorID
    }

    private var currentActorID: String? {
        // The detail surface lives inside RootTabView's scope, which
        // installs the AppOnboardingCoordinator into the environment.
        // We pull the active actor id directly from there so the bubble
        // identity question — "did I send this?" — has a single source
        // of truth that matches the rest of the app.
        coordinator?.currentContext?.memberActorID
    }

    @Environment(AppOnboardingCoordinator.self) private var coordinator: AppOnboardingCoordinator?

    private var senderDisplayName: String {
        guard let senderID = event.senderActorID, !senderID.isEmpty else { return "You" }
        if senderID == currentActorID { return "You" }
        if let name = actorMap.displayName(for: senderID) { return name }
        return String(senderID.prefix(8))
    }

    /// Display name for the model that produced this event (assistant reply
    /// types only). Returns nil for non-stamped events or when no runtime is
    /// available to resolve the display name.
    private var modelDisplayName: String? {
        guard let runtime else { return nil }
        return event.modelDisplayName(via: runtime)
    }

    /// Header label shown above an assistant bubble: "{Agent name} · {Model}"
    /// when both are resolvable, the agent name alone when the model isn't
    /// stamped, the model alone when the agent identity can't be resolved
    /// (e.g. event was stamped with a runtime_id before the runtime→actor
    /// mapping was available), nil when neither resolves. Caption-style at
    /// the call site.
    private var assistantHeaderLabel: String? {
        let agent = senderDisplayName.isEmpty ? nil : senderDisplayName
        let model = modelDisplayName
        switch (agent, model) {
        case let (.some(a), .some(m)): return "\(a) · \(m)"
        case let (.some(a), .none): return a
        case let (.none, .some(m)): return m
        case (.none, .none): return nil
        }
    }

    public var body: some View {
        Group {
            switch event.eventType {
            case "user_prompt":
                userBubble
            case "output":
                assistantBubble
            case "thinking":
                thinkingBlock
            case "tool_use":
                toolUseBlock
            case "tool_result":
                EmptyView()
            case "error":
                errorBlock
            case "permission_request":
                PermissionBannerView(
                    toolName: event.toolName ?? "",
                    description: event.text ?? "",
                    requestId: event.toolId ?? "",
                    isResolved: event.isComplete == true,
                    wasGranted: event.success,
                    onGrant: event.isComplete == true ? nil : { id in onGrant?(id, event.senderActorID) },
                    onDeny: event.isComplete == true ? nil : { id in onDeny?(id, event.senderActorID) }
                )
                .padding(.horizontal, 16)
                .padding(.vertical, 4)
            default:
                EmptyView()
            }
        }
        .fullScreenCover(item: $fullscreenImageContext) { ctx in
            FullScreenSessionImageViewer(sessionID: ctx.sessionID, initialURL: ctx.initialURL)
        }
    }

    // MARK: - User Bubble
    //
    // Local user → right-aligned, Cinnabar-tinted glass with "You" label.
    // Another collaborator → left-aligned plain glass with their display
    // name. Mirrors the iMessage convention where outgoing and incoming
    // bubbles read at opposite edges of the canvas.

    private var userBubble: some View {
        if isFromOtherUser {
            return AnyView(otherUserBubble)
        } else {
            return AnyView(selfUserBubble)
        }
    }

    private var selfUserBubble: some View {
        let parsed = ParsedMessageContent.parse(event.text ?? "")
        return VStack(alignment: .trailing, spacing: 2) {
            Text("You")
                .font(.caption)
                .foregroundStyle(Color.amux.basalt)
                .padding(.trailing, 4)

            HStack(alignment: .bottom, spacing: 0) {
                Spacer(minLength: 0)
                HStack(alignment: .bottom, spacing: 6) {
                    if let outboxID = event.outboxMessageID {
                        OutboxStatusDot(outboxMessageID: outboxID, onRetry: onRetryOutbox)
                    }
                    VStack(alignment: .trailing, spacing: 6) {
                        if let outboxID = event.outboxMessageID {
                            SentAttachmentsView(outboxMessageID: outboxID) { url, sid in
                                fullscreenImageContext = FullscreenImageContext(
                                    initialURL: url, sessionID: sid
                                )
                            }
                        }
                        ForEach(Array(parsed.imageURLs.enumerated()), id: \.offset) { _, url in
                            AsyncImage(url: url) { phase in
                                switch phase {
                                case .success(let image):
                                    image.resizable().scaledToFit()
                                        .clipShape(RoundedRectangle(cornerRadius: 12))
                                default:
                                    RoundedRectangle(cornerRadius: 12)
                                        .fill(Color.amux.pebble)
                                        .overlay(ProgressView())
                                        .frame(height: 150)
                                }
                            }
                        }
                        if !parsed.text.isEmpty {
                            Text(parsed.text)
                                .font(.subheadline)
                                .foregroundStyle(Color.amux.mist)
                                .textSelection(.enabled)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 10)
                                .liquidGlass(in: RoundedRectangle(cornerRadius: 18),
                                             tint: Color.amux.cinnabar,
                                             interactive: false)
                                .contextMenu {
                                    MessageContextMenu(text: event.text ?? "")
                                    if onEdit != nil || onDelete != nil {
                                        Divider()
                                    }
                                    if let onEdit {
                                        Button {
                                            onEdit()
                                        } label: {
                                            Label("Edit", systemImage: "pencil")
                                        }
                                    }
                                    if let onDelete {
                                        Button(role: .destructive) {
                                            onDelete()
                                        } label: {
                                            Label("Delete", systemImage: "trash")
                                        }
                                    }
                                }
                        }
                    }
                }
                .frame(maxWidth: sizeClass == .regular ? 500 : 260, alignment: .trailing)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
    }

    private var otherUserBubble: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(senderDisplayName)
                .font(.caption)
                .foregroundStyle(Color.amux.basalt)
                .padding(.leading, 4)

            HStack {
                Text(event.text ?? "")
                    .font(.subheadline)
                    .foregroundStyle(Color.amux.onyx)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .liquidGlass(in: RoundedRectangle(cornerRadius: 18), interactive: false)
                    .frame(maxWidth: sizeClass == .regular ? 500 : 260, alignment: .leading)
                    .contextMenu {
                        MessageContextMenu(text: event.text ?? "")
                    }
                Spacer()
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
    }

    // MARK: - Assistant Bubble (gray, left-aligned, markdown)

    private var assistantBubble: some View {
        VStack(alignment: .leading, spacing: 2) {
            if showsAssistantHeader, let header = assistantHeaderLabel {
                Text(header)
                    .font(.caption)
                    .foregroundStyle(Color.amux.basalt)
                    .padding(.leading, 4)
            }
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    MarkdownRenderer(content: event.text ?? "")
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .liquidGlass(in: RoundedRectangle(cornerRadius: 18), interactive: false)
                .contextMenu {
                    MessageContextMenu(text: event.text ?? "")
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
    }

    // MARK: - Thinking Block

    private var thinkingBlock: some View {
        ThinkingBlockView(text: event.text ?? "")
            .contextMenu {
                MessageContextMenu(text: event.text ?? "")
            }
    }

    // MARK: - Tool Use

    private var toolUseBlock: some View {
        Group {
            if event.isComplete == true {
                CompactToolLine(event: event)
            } else {
                ToolCallView(
                    toolName: event.toolName ?? "Unknown",
                    toolId: event.toolId ?? "",
                    description: event.text ?? "",
                    status: "running"
                )
                .padding(.horizontal, 16)
                .padding(.vertical, 2)
            }
        }
        .contextMenu {
            MessageContextMenu(text: event.text ?? "")
        }
    }

    // MARK: - Error

    private var errorBlock: some View {
        ErrorBlockView(message: event.text ?? "Unknown error")
    }
}

// MARK: - ActiveStreamCardView
//
// Compact full-width card rendered for an agent whose runtime is still
// producing output. Replaces the live thinking/tool/output stream that
// used to clutter the main feed when multiple agents work in parallel.
// Tap routes to `StreamingDetailView` for the full event timeline.

public struct ActiveStreamCardView: View {
    public let agentName: String
    /// Latest single-line text drawn from (in priority): live streaming
    /// text buffer, the most recent runtime event's text, or "Working…"
    /// when nothing readable has arrived yet. Ignored when `isPending`
    /// is true — the placeholder label takes precedence there.
    public let lastLine: String
    /// True when the agent has been engaged (send tapped) but no ACP
    /// runtime event or text delta has come back yet. Drives the
    /// breathing-light color (cinnabar = waiting) and the placeholder
    /// label ("Agent loading…"). Flips false the moment the first event
    /// arrives, at which point the dot turns sage and the label switches
    /// to the live last-line preview.
    public let isPending: Bool

    @State private var pulse = false
    @State private var pendingElapsed: TimeInterval = 0
    @State private var pendingTicker: Timer? = nil

    /// Seconds the pending card must stay visible before its label
    /// switches from "Agent loading…" to the patience copy. Cold-spawn
    /// agents routinely take >10s before the first delta lands, so 15s
    /// is the point where the user starts to wonder if anything is happening.
    private static let patienceThreshold: TimeInterval = 15

    public init(agentName: String, lastLine: String, isPending: Bool = false) {
        self.agentName = agentName
        self.lastLine = lastLine
        self.isPending = isPending
    }

    private var dotColor: Color {
        isPending ? Color.amux.cinnabar : Color.amux.sage
    }

    private var displayText: String {
        if isPending {
            if pendingElapsed >= Self.patienceThreshold {
                return "Agent 启动较慢，请耐心等候…"
            }
            return "Agent loading…"
        }
        return lastLine.isEmpty ? "Working…" : lastLine
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(agentName)
                .font(.caption)
                .foregroundStyle(Color.amux.basalt)
                .padding(.leading, 4)

            HStack(alignment: .center, spacing: 10) {
                Circle()
                    .fill(dotColor)
                    .frame(width: 8, height: 8)
                    .scaleEffect(pulse ? 1.25 : 0.85)
                    .opacity(pulse ? 0.55 : 1.0)
                    .animation(AMUXAnimation.fast, value: dotColor)

                Text(displayText)
                    .font(.subheadline)
                    .foregroundStyle(Color.amux.onyx)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Image(systemName: "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .liquidGlass(in: RoundedRectangle(cornerRadius: 18), interactive: true)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .onAppear {
            withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) {
                pulse.toggle()
            }
            if isPending { startPendingTicker() }
        }
        .onDisappear { stopPendingTicker() }
        .onChange(of: isPending) { _, nowPending in
            if nowPending {
                startPendingTicker()
            } else {
                stopPendingTicker()
                pendingElapsed = 0
            }
        }
    }

    private func startPendingTicker() {
        stopPendingTicker()
        let started = Date()
        pendingElapsed = 0
        pendingTicker = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
            Task { @MainActor in
                pendingElapsed = Date().timeIntervalSince(started)
            }
        }
    }

    private func stopPendingTicker() {
        pendingTicker?.invalidate()
        pendingTicker = nil
    }
}

// MARK: - CompletedTurnBubbleView
//
// Final assistant bubble for a completed turn. Same look as
// `EventBubbleView.assistantBubble` (gray glass, markdown, model caption)
// but with an extra detail-icon overlay bottom-right that pushes the
// streaming detail when the turn produced any thinking / tool runs the
// user might want to inspect.

public struct CompletedTurnBubbleView<DetailIcon: View>: View {
    public let finalEvent: AgentEvent
    public let runtime: Runtime?
    public let agentName: String?
    /// Optional content slot rendered bottom-right of the bubble. Used to
    /// host a `NavigationLink(value:)` so taps push the streaming detail
    /// — kept generic here so this view doesn't depend on the navigation
    /// route type defined in `StreamingDetailView.swift`.
    @ViewBuilder public let detailIcon: () -> DetailIcon

    public init(finalEvent: AgentEvent,
                runtime: Runtime?,
                agentName: String?,
                @ViewBuilder detailIcon: @escaping () -> DetailIcon = { EmptyView() }) {
        self.finalEvent = finalEvent
        self.runtime = runtime
        self.agentName = agentName
        self.detailIcon = detailIcon
    }

    private var modelDisplayName: String? {
        guard let runtime else { return nil }
        return finalEvent.modelDisplayName(via: runtime)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let agentName, !agentName.isEmpty {
                Text(agentName)
                    .font(.caption)
                    .foregroundStyle(Color.amux.basalt)
                    .padding(.leading, 4)
            }

            ZStack(alignment: .bottomTrailing) {
                VStack(alignment: .leading, spacing: 4) {
                    MarkdownRenderer(content: finalEvent.text ?? "")
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .liquidGlass(in: RoundedRectangle(cornerRadius: 18), interactive: false)
                .contextMenu {
                    MessageContextMenu(text: finalEvent.text ?? "")
                }

                detailIcon()
            }

            if let modelName = modelDisplayName {
                Text(modelName)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 18)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
    }
}

// MARK: - ThinkingBlockView
//
// Hai-language thinking row: mono uppercase eyebrow + slate inline preview.
// Expanded body sits behind a hairline left-rule indent, no card chrome,
// matching the wabi-sabi "spare the vermillion + trace of the hand" rules
// in `apps/ios/DESIGN.md`.

struct ThinkingBlockView: View {
    let text: String
    @State private var isExpanded = false

    private var trimmedPreview: String {
        let collapsed = text
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard collapsed.count > 80 else { return collapsed }
        return String(collapsed.prefix(80)) + "…"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Text("THINKING")
                        .font(.system(size: 9, design: .monospaced))
                        .tracking(2)
                        .foregroundStyle(Color.amux.slate)
                    if !isExpanded, !trimmedPreview.isEmpty {
                        Text(trimmedPreview)
                            .font(.caption2)
                            .foregroundStyle(Color.amux.slate)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .medium))
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .foregroundStyle(Color.amux.slate.opacity(0.6))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                HStack(alignment: .top, spacing: 12) {
                    Rectangle()
                        .fill(Color.amux.hairline)
                        .frame(width: 0.5)
                    Text(text)
                        .font(.caption)
                        .foregroundStyle(Color.amux.basalt)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
    }
}

// MARK: - ErrorBlockView

struct ErrorBlockView: View {
    let message: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Color.amux.cinnabarDeep)
            Text(message)
                .font(.caption)
                .foregroundStyle(Color.amux.cinnabarDeep)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .liquidGlass(in: RoundedRectangle(cornerRadius: 12),
                     tint: Color.amux.cinnabarDeep,
                     interactive: false)
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
        .contextMenu {
            MessageContextMenu(text: message)
        }
    }
}

// MARK: - TypingIndicatorView

struct TypingIndicatorView: View {
    @State private var phase = 0.0

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3) { i in
                Circle()
                    .fill(Color.amux.slate)
                    .frame(width: 8, height: 8)
                    .scaleEffect(dotScale(for: i))
                    .opacity(dotOpacity(for: i))
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .liquidGlass(in: RoundedRectangle(cornerRadius: 18), interactive: false)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
        .onAppear {
            withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) {
                phase = 1
            }
        }
    }

    private func dotScale(for index: Int) -> Double {
        let offset = Double(index) * 0.15
        let value = sin((phase + offset) * .pi)
        return 0.6 + 0.4 * value
    }

    private func dotOpacity(for index: Int) -> Double {
        let offset = Double(index) * 0.15
        let value = sin((phase + offset) * .pi)
        return 0.4 + 0.6 * value
    }
}

// MARK: - FullscreenImageContext

private struct FullscreenImageContext: Identifiable {
    let id = UUID()
    let initialURL: URL
    let sessionID: String
}

// MARK: - FullScreenSessionImageViewer

/// Full-screen paging image viewer for all attachment images in a session.
/// Queries every OutboxMessage for `sessionID`, flattens their attachment URLs
/// in chronological order, and presents them in a paging TabView so the user
/// can swipe left/right between images. Opens at the tapped image's index.
private struct FullScreenSessionImageViewer: View {
    @Environment(\.dismiss) private var dismiss
    let sessionID: String
    let initialURL: URL

    @Query private var messages: [OutboxMessage]
    @State private var currentIndex: Int = 0

    init(sessionID: String, initialURL: URL) {
        self.sessionID = sessionID
        self.initialURL = initialURL
        let sid = sessionID
        _messages = Query(
            filter: #Predicate<OutboxMessage> { $0.sessionID == sid },
            sort: \.createdAt
        )
    }

    private var allURLs: [URL] {
        messages.flatMap { $0.attachmentURLs }
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()

            if allURLs.isEmpty {
                AsyncImage(url: initialURL) { phase in
                    imagePhaseView(phase)
                }
                .padding()
            } else {
                TabView(selection: $currentIndex) {
                    ForEach(Array(allURLs.enumerated()), id: \.offset) { idx, url in
                        AsyncImage(url: url) { phase in
                            imagePhaseView(phase)
                        }
                        .tag(idx)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: allURLs.count > 1 ? .always : .never))
                .ignoresSafeArea()
            }

            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.title2)
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, Color.black.opacity(0.5))
            }
            .buttonStyle(.plain)
            .padding(.top, 56)
            .padding(.trailing, 20)
        }
        .onAppear { seekToInitial() }
        .onChange(of: allURLs) { _, _ in seekToInitial() }
    }

    @ViewBuilder
    private func imagePhaseView(_ phase: AsyncImagePhase) -> some View {
        switch phase {
        case .success(let image):
            image.resizable()
                .scaledToFit()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failure:
            VStack(spacing: 12) {
                Image(systemName: "photo.badge.exclamationmark")
                    .font(.system(size: 48))
                    .foregroundStyle(.secondary)
                Text("Failed to load")
                    .foregroundStyle(.secondary)
            }
        default:
            ProgressView()
                .tint(.white)
        }
    }

    private func seekToInitial() {
        guard let idx = allURLs.firstIndex(of: initialURL) else { return }
        currentIndex = idx
    }
}

// MARK: - OutboxStatusDot

/// Tiny accessory rendered to the right of a self-authored user_prompt
/// bubble showing the OutboxMessage row's lifecycle state. Reads via a
/// targeted `@Query` filtered by `messageID` so updates to a single row
/// do not invalidate the whole bubble list. Tap on `.failed` calls back
/// into the parent's `OutboxSender.retry` handler.
struct OutboxStatusDot: View {
    let outboxMessageID: String
    let onRetry: ((String) -> Void)?

    @Query private var rows: [OutboxMessage]

    init(outboxMessageID: String, onRetry: ((String) -> Void)?) {
        self.outboxMessageID = outboxMessageID
        self.onRetry = onRetry
        let id = outboxMessageID
        _rows = Query(filter: #Predicate<OutboxMessage> { $0.messageID == id })
    }

    private var state: OutboxState? { rows.first?.state }

    var body: some View {
        Group {
            switch state {
            case .pending, .inFlight:
                Image(systemName: "circle.dashed")
                    .font(.system(size: 11, weight: .regular))
                    .foregroundStyle(Color.amux.basalt)
                    .accessibilityLabel("Sending")
            case .delivered:
                Image(systemName: "checkmark")
                    .font(.system(size: 10, weight: .regular))
                    .foregroundStyle(Color.amux.basalt.opacity(0.5))
                    .accessibilityLabel("Delivered")
            case .failed:
                Button {
                    onRetry?(outboxMessageID)
                } label: {
                    Image(systemName: "exclamationmark.circle.fill")
                        .font(.system(size: 12, weight: .regular))
                        .foregroundStyle(Color.amux.cinnabarDeep)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Retry sending message")
            case nil:
                EmptyView()
            }
        }
        .padding(.bottom, 6)
    }
}

// MARK: - SentAttachmentsView

/// Renders attachment images for a locally-sent user_prompt bubble.
/// Queries the `OutboxMessage` row via `outboxMessageID` so the images
/// surface as soon as the upload completes, without needing a full
/// AgentEvent schema migration. Only fires for messages sent from this
/// device (outboxMessageID is nil for remote messages).
private struct SentAttachmentsView: View {
    @Query private var rows: [OutboxMessage]
    let onTap: ((URL, String) -> Void)?

    init(outboxMessageID: String, onTap: ((URL, String) -> Void)? = nil) {
        let id = outboxMessageID
        _rows = Query(filter: #Predicate<OutboxMessage> { $0.messageID == id })
        self.onTap = onTap
    }

    private var attachmentURLs: [URL] { rows.first?.attachmentURLs ?? [] }
    private var sessionID: String { rows.first?.sessionID ?? "" }

    var body: some View {
        ForEach(Array(attachmentURLs.enumerated()), id: \.offset) { _, url in
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFit()
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                default:
                    RoundedRectangle(cornerRadius: 12)
                        .fill(Color.amux.pebble)
                        .frame(height: 150)
                }
            }
            .onTapGesture { onTap?(url, sessionID) }
        }
    }
}

// MARK: - MessageContentParser

private struct ParsedMessageContent {
    let text: String
    let imageURLs: [URL]
    static let imageExtensions: Set<String> = ["jpg", "jpeg", "png", "gif", "webp", "heic", "bmp"]

    static func parse(_ raw: String) -> ParsedMessageContent {
        let lines = raw.components(separatedBy: "\n")
        var imageURLs: [URL] = []
        var textLines: [String] = []
        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let url = URL(string: trimmed),
               url.scheme?.hasPrefix("http") == true,
               !url.host.isNilOrEmpty,
               imageExtensions.contains(url.pathExtension.lowercased()) {
                imageURLs.append(url)
            } else {
                textLines.append(line)
            }
        }
        let text = textLines.joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return ParsedMessageContent(text: text, imageURLs: imageURLs)
    }
}

private extension Optional where Wrapped == String {
    var isNilOrEmpty: Bool { self?.isEmpty != false }
}

// MARK: - MessageContextMenu

struct MessageContextMenu: View {
    let text: String

    var body: some View {
        Button {
            UIPasteboard.general.string = text
        } label: {
            Label("Copy", systemImage: "doc.on.doc")
        }

        if let url = URL(string: text), UIApplication.shared.canOpenURL(url) {
            Button {
                UIApplication.shared.open(url)
            } label: {
                Label("Open Link", systemImage: "safari")
            }
        }

        ShareLink(item: text) {
            Label("Share", systemImage: "square.and.arrow.up")
        }
    }
}

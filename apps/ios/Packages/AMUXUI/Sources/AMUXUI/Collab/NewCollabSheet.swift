import SwiftUI
import AMUXCore

public struct NewCollabSheet: View {
    let teamclawService: TeamclawService
    let teamId: String
    let targetActorID: String
    let peerId: String
    let onCreated: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var summary = ""
    @State private var isSending = false

    public init(
        teamclawService: TeamclawService,
        teamId: String,
        targetActorID: String,
        peerId: String,
        onCreated: @escaping (String) -> Void
    ) {
        self.teamclawService = teamclawService
        self.teamId = teamId
        self.targetActorID = targetActorID
        self.peerId = peerId
        self.onCreated = onCreated
    }

    public var body: some View {
        NavigationStack {
            Form {
                Section("Session") {
                    TextField("Title", text: $title)
                    TextField("Summary (optional)", text: $summary, axis: .vertical)
                        .lineLimit(3...6)
                }
            }
            .navigationTitle("New Collab Session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.title3)
                            .foregroundStyle(.primary)
                    }
                    .buttonStyle(.plain)
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    let canCreate = !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSending
                    Button { createSession() } label: {
                        Text("Create")
                            .font(.subheadline).fontWeight(.semibold)
                            .foregroundStyle(canCreate ? Color.amux.cinnabar : Color.amux.slate.opacity(0.5))
                    }
                    .buttonStyle(.plain)
                    .disabled(!canCreate)
                }
            }
        }
    }

    private func createSession() {
        guard let mqtt = teamclawService.mqttRef else { return }
        isSending = true

        let createReq = teamclawService.makeCreateSessionRequest(
            teamId: teamId,
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            summary: summary.trimmingCharacters(in: .whitespacesAndNewlines)
        )

        guard !targetActorID.isEmpty else {
            isSending = false
            return
        }
        var rpcReq = Teamclaw_RpcRequest()
        rpcReq.requestID = String(UUID().uuidString.prefix(8).lowercased())
        // Stamp the requester so the daemon routes the response to our actor's
        // rpc/res topic (apps/daemon/src/teamclaw/rpc.rs).
        if let requester = teamclawService.currentHumanActorId {
            rpcReq.requesterActorID = requester
        }
        rpcReq.method = .createSession(createReq)

        let topic = MQTTTopics.actorRpcRequest(teamID: teamId, actorID: targetActorID)
        if let data = try? rpcReq.serializedData() {
            Task {
                try? await mqtt.publish(topic: topic, payload: data, retain: false)
            }
        }

        dismiss()
    }
}

import Foundation
import SwiftProtobuf

enum ProtoMQTTCoder {

    static func encode(_ message: Teamclaw_MqttMessage) -> Data? {
        try? message.serializedData()
    }

    static func decode(_ data: Data) -> Teamclaw_MqttMessage? {
        try? Teamclaw_MqttMessage(serializedBytes: data)
    }

    static func makeEnvelope(_ payload: Teamclaw_MqttMessage.OneOf_Payload) -> Teamclaw_MqttMessage {
        var msg = Teamclaw_MqttMessage()
        msg.id = UUID().uuidString
        msg.timestamp = Date().timeIntervalSince1970
        msg.payload = payload
        return msg
    }

    static func summary(_ msg: Teamclaw_MqttMessage) -> String {
        let type: String
        switch msg.payload {
        case .sessionSyncRequest(let r):  type = "SessionSyncReq(page=\(r.pagination.page),after=\(r.afterUpdated))"
        case .sessionSyncResponse(let r): type = "SessionSyncRes(sessions=\(r.sessions.count), page=\(r.pagination.page)/total=\(r.pagination.total))"
        case .chatRequest(let r):         type = "ChatReq(session=\(r.sessionID.prefix(8)))"
        case .chatResponse(let r):
            let eventDesc: String
            switch r.event {
            case .delta: eventDesc = "delta"
            case .done: eventDesc = "done"
            case .error: eventDesc = "error"
            case .toolEvent(let t): eventDesc = "tool(\(t.toolName),\(t.status))"
            case .hasThinking: eventDesc = "thinking"
            case .none: eventDesc = "none"
            @unknown default: eventDesc = "unknown"
            }
            type = "ChatRes(session=\(r.sessionID.prefix(8)),seq=\(r.seq),\(eventDesc))"
        case .chatCancel(let r):          type = "ChatCancel(session=\(r.sessionID.prefix(8)))"
        case .memberSyncRequest(let r):   type = "MemberSyncReq(page=\(r.pagination.page))"
        case .memberSyncResponse(let r):  type = "MemberSyncRes(members=\(r.members.count))"
        case .automationSyncRequest(let r):  type = "AutoSyncReq(page=\(r.pagination.page))"
        case .automationSyncResponse(let r): type = "AutoSyncRes(tasks=\(r.tasks.count))"
        case .skillSyncRequest:              type = "SkillSyncReq"
        case .skillSyncResponse(let r):      type = "SkillSyncRes(skills=\(r.skills.count))"
        case .talentSyncRequest:             type = "TalentSyncReq"
        case .talentSyncResponse(let r):     type = "TalentSyncRes(talents=\(r.talents.count))"
        case .taskUpdate(let r):             type = "TaskUpdate(task=\(r.taskID.prefix(8)),status=\(r.status))"
        case .messageSyncRequest(let r):     type = "MsgSyncReq(session=\(r.sessionID.prefix(8)))"
        case .messageSyncResponse(let r):    type = "MsgSyncRes(msgs=\(r.messages.count))"
        case .statusReport(let s):           type = "StatusReport(online=\(s.online))"
        case .pairingRequest:               type = "PairingReq"
        case .pairingResponse:              type = "PairingRes"
        case .pairingDiscovery:             type = "PairingDiscovery"
        case .none:                         type = "nil"
        default:                            type = "unknown(\(String(describing: msg.payload).prefix(40)))"
        }
        return "id=\(msg.id.prefix(8)) \(type)"
    }
}

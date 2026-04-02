import Foundation

// MARK: - MQTTMessageType

enum MQTTMessageType: String, Codable {
    case chatRequest = "chat_request"
    case chatResponse = "chat_response"
    case status
    case taskUpdate = "task_update"
    case skillSync = "skill_sync"
    case memberSync = "member_sync"
}

// MARK: - Payload Structs

struct ChatRequestPayload: Codable {
    let sessionID: String
    let content: String
    let imageURL: String?
    let model: String?

    enum CodingKeys: String, CodingKey {
        case sessionID = "session_id"
        case content
        case imageURL = "image_url"
        case model
    }
}

struct ChatResponsePayload: Codable {
    let sessionID: String
    let seq: Int
    let delta: String
    let done: Bool
    let full: String?

    enum CodingKeys: String, CodingKey {
        case sessionID = "session_id"
        case seq
        case delta
        case done
        case full
    }
}

struct StatusPayload: Codable {
    let online: Bool
    let deviceName: String?

    enum CodingKeys: String, CodingKey {
        case online
        case deviceName = "device_name"
    }
}

struct TaskUpdatePayload: Codable {
    let taskID: String
    let status: String
    let lastRunTime: TimeInterval?

    enum CodingKeys: String, CodingKey {
        case taskID = "task_id"
        case status
        case lastRunTime = "last_run_time"
    }
}

struct SkillSyncPayload: Codable {
    let skills: [SkillData]

    struct SkillData: Codable {
        let id: String
        let name: String
        let description: String
        let isPersonal: Bool
        let isEnabled: Bool

        enum CodingKeys: String, CodingKey {
            case id
            case name
            case description
            case isPersonal = "is_personal"
            case isEnabled = "is_enabled"
        }
    }
}

struct MemberSyncPayload: Codable {
    let members: [MemberData]

    struct MemberData: Codable {
        let id: String
        let name: String
        let avatarURL: String
        let note: String

        enum CodingKeys: String, CodingKey {
            case id
            case name
            case avatarURL = "avatar_url"
            case note
        }
    }
}

// MARK: - MQTTPayload

enum MQTTPayload {
    case chatRequest(ChatRequestPayload)
    case chatResponse(ChatResponsePayload)
    case status(StatusPayload)
    case taskUpdate(TaskUpdatePayload)
    case skillSync(SkillSyncPayload)
    case memberSync(MemberSyncPayload)
}

// MARK: - MQTTMessage

struct MQTTMessage {
    let id: String
    let type: MQTTMessageType
    let timestamp: TimeInterval
    let payload: MQTTPayload
}

// MARK: - MQTTMessage Codable

extension MQTTMessage: Codable {

    private enum CodingKeys: String, CodingKey {
        case id
        case type
        case timestamp
        case payload
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        type = try container.decode(MQTTMessageType.self, forKey: .type)
        timestamp = try container.decode(TimeInterval.self, forKey: .timestamp)

        switch type {
        case .chatRequest:
            let p = try container.decode(ChatRequestPayload.self, forKey: .payload)
            payload = .chatRequest(p)
        case .chatResponse:
            let p = try container.decode(ChatResponsePayload.self, forKey: .payload)
            payload = .chatResponse(p)
        case .status:
            let p = try container.decode(StatusPayload.self, forKey: .payload)
            payload = .status(p)
        case .taskUpdate:
            let p = try container.decode(TaskUpdatePayload.self, forKey: .payload)
            payload = .taskUpdate(p)
        case .skillSync:
            let p = try container.decode(SkillSyncPayload.self, forKey: .payload)
            payload = .skillSync(p)
        case .memberSync:
            let p = try container.decode(MemberSyncPayload.self, forKey: .payload)
            payload = .memberSync(p)
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(type, forKey: .type)
        try container.encode(timestamp, forKey: .timestamp)

        switch payload {
        case .chatRequest(let p):
            try container.encode(p, forKey: .payload)
        case .chatResponse(let p):
            try container.encode(p, forKey: .payload)
        case .status(let p):
            try container.encode(p, forKey: .payload)
        case .taskUpdate(let p):
            try container.encode(p, forKey: .payload)
        case .skillSync(let p):
            try container.encode(p, forKey: .payload)
        case .memberSync(let p):
            try container.encode(p, forKey: .payload)
        }
    }
}

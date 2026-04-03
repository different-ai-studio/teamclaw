import Foundation

// MARK: - MQTTMessageType

enum MQTTMessageType: String, Codable {
    case chatRequest = "chat_request"
    case chatResponse = "chat_response"
    case status
    case taskUpdate = "task_update"
    case skillSync = "skill_sync"
    case memberSync = "member_sync"
    case sessionListRequest = "session_list_request"
    case sessionSync = "session_sync"
    case automationSync = "automation_sync"
    case talentSync = "talent_sync"
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
        let department: String?
        let isAIAlly: Bool?
        let note: String

        enum CodingKeys: String, CodingKey {
            case id
            case name
            case avatarURL = "avatar_url"
            case department
            case isAIAlly = "is_ai_ally"
            case note
        }
    }
}

struct AutomationSyncPayload: Codable {
    let tasks: [AutomationTaskData]

    struct AutomationTaskData: Codable {
        let id: String
        let name: String
        let status: String?
        let cronExpression: String
        let description: String
        let lastRunTime: TimeInterval?

        enum CodingKeys: String, CodingKey {
            case id, name, status, description
            case cronExpression = "cron_expression"
            case lastRunTime = "last_run_time"
        }
    }
}

struct TalentSyncPayload: Codable {
    let talents: [TalentData]

    struct TalentData: Codable {
        let id: String
        let name: String
        let description: String
        let category: String
        let icon: String?
        let downloads: Int?
    }
}

struct SessionSyncPayload: Codable {
    let sessions: [SessionData]

    struct SessionData: Codable {
        let id: String
        let title: String
        let updated: Int64
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
    case sessionListRequest
    case sessionSync(SessionSyncPayload)
    case automationSync(AutomationSyncPayload)
    case talentSync(TalentSyncPayload)
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
        case .sessionListRequest:
            payload = .sessionListRequest
        case .sessionSync:
            let p = try container.decode(SessionSyncPayload.self, forKey: .payload)
            payload = .sessionSync(p)
        case .automationSync:
            let p = try container.decode(AutomationSyncPayload.self, forKey: .payload)
            payload = .automationSync(p)
        case .talentSync:
            let p = try container.decode(TalentSyncPayload.self, forKey: .payload)
            payload = .talentSync(p)
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
        case .sessionListRequest:
            try container.encode([String: String](), forKey: .payload)
        case .sessionSync(let p):
            try container.encode(p, forKey: .payload)
        case .automationSync(let p):
            try container.encode(p, forKey: .payload)
        case .talentSync(let p):
            try container.encode(p, forKey: .payload)
        }
    }
}

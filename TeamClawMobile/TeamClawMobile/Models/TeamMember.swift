import Foundation
import SwiftData

@Model
final class TeamMember {
    @Attribute(.unique) var id: String
    var name: String
    var avatarURL: String?
    var department: String?
    var isAIAlly: Bool
    var note: String?

    init(
        id: String,
        name: String,
        avatarURL: String? = nil,
        department: String? = nil,
        isAIAlly: Bool = false,
        note: String? = nil
    ) {
        self.id = id
        self.name = name
        self.avatarURL = avatarURL
        self.department = department
        self.isAIAlly = isAIAlly
        self.note = note
    }

    static let mockMembers: [TeamMember] = [
        TeamMember(id: "1", name: "张伟", department: "工程部", isAIAlly: false),
        TeamMember(id: "2", name: "李娜", department: "产品部", isAIAlly: false),
        TeamMember(id: "3", name: "王磊", department: "设计部", isAIAlly: false),
        TeamMember(id: "4", name: "AI 搭档", department: "工程部", isAIAlly: true),
        TeamMember(id: "5", name: "陈静", department: "市场部", isAIAlly: false),
        TeamMember(id: "6", name: "AI 搭档", department: "产品部", isAIAlly: true),
    ]
}

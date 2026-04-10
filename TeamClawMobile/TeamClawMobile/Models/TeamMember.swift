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
}

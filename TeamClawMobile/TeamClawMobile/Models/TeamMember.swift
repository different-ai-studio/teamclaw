import Foundation
import SwiftData

@available(iOS 17.0, *)
@Model
final class TeamMember {
    @Attribute(.unique) var id: String
    var name: String
    var avatarURL: String?
    var note: String?

    init(
        id: String,
        name: String,
        avatarURL: String? = nil,
        note: String? = nil
    ) {
        self.id = id
        self.name = name
        self.avatarURL = avatarURL
        self.note = note
    }
}

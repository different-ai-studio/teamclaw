import Foundation
import SwiftData

@available(iOS 17.0, *)
@Model
final class Skill {
    @Attribute(.unique) var id: String
    var name: String
    var skillDescription: String
    var isPersonal: Bool
    var isEnabled: Bool

    init(
        id: String,
        name: String,
        skillDescription: String,
        isPersonal: Bool,
        isEnabled: Bool
    ) {
        self.id = id
        self.name = name
        self.skillDescription = skillDescription
        self.isPersonal = isPersonal
        self.isEnabled = isEnabled
    }
}

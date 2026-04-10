import Foundation
import SwiftData

@Model
final class Talent {
    @Attribute(.unique) var id: String
    var name: String
    var talentDescription: String
    var category: String
    var icon: String
    var downloads: Int
    var role: String
    var whenToUse: String
    var workingStyle: String

    init(
        id: String,
        name: String,
        talentDescription: String,
        category: String,
        icon: String,
        downloads: Int,
        role: String = "",
        whenToUse: String = "",
        workingStyle: String = ""
    ) {
        self.id = id
        self.name = name
        self.talentDescription = talentDescription
        self.category = category
        self.icon = icon
        self.downloads = downloads
        self.role = role
        self.whenToUse = whenToUse
        self.workingStyle = workingStyle
    }
}

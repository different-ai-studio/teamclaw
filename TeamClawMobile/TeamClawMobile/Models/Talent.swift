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

    init(
        id: String,
        name: String,
        talentDescription: String,
        category: String,
        icon: String,
        downloads: Int
    ) {
        self.id = id
        self.name = name
        self.talentDescription = talentDescription
        self.category = category
        self.icon = icon
        self.downloads = downloads
    }
}

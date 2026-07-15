import Foundation

/// Humanized random team name for the "try it first" anonymous onboarding
/// path. Generates names like "Curious Otter" / "Brave Panda" so anonymous
/// users land on a non-throwaway-looking workspace.
public enum RandomTeamName {
    private static let adjectives = [
        "Curious", "Brave", "Calm", "Eager", "Lively", "Mellow", "Nimble",
        "Quick", "Quiet", "Sunny", "Witty", "Zesty", "Bright", "Daring",
        "Gentle", "Jolly", "Keen", "Plucky", "Spry", "Sparkling",
    ]

    private static let animals = [
        "Otter", "Panda", "Falcon", "Fox", "Heron", "Lynx", "Owl", "Puffin",
        "Quokka", "Raven", "Seal", "Tapir", "Viper", "Walrus", "Yak", "Zebra",
        "Badger", "Cougar", "Dolphin", "Hare",
    ]

    public static func generate() -> String {
        let adj = adjectives.randomElement() ?? "Curious"
        let animal = animals.randomElement() ?? "Otter"
        return "\(adj) \(animal)"
    }
}

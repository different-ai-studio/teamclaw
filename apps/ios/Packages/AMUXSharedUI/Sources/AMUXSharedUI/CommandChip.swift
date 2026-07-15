import SwiftUI

// MARK: - Parser

/// Detect a leading slash command in `text` and split into the command
/// name and any remaining body. Returns nil when `text` does not start
/// with `/<letter>[\w-]*` followed by whitespace, newline, or end-of-string.
///
/// Examples:
///   "/cmd args here" → ("cmd", "args here")
///   "/cmd"           → ("cmd", "")
///   "/123"           → nil   (must start with a letter)
///   "/"              → nil
///   " /cmd"          → nil   (no leading whitespace allowed)
///
/// Does NOT check membership against `availableCommands` — historical
/// messages may reference retired commands and should still chip-render.
public func extractSlashCommand(_ text: String) -> (command: String, rest: String)? {
    guard text.hasPrefix("/"), text.count > 1 else { return nil }

    let afterSlash = text.dropFirst()
    guard let first = afterSlash.first, first.isLetter else { return nil }

    // Collect command-name characters (letters, digits, _, -).
    var nameEnd = afterSlash.startIndex
    while nameEnd < afterSlash.endIndex {
        let ch = afterSlash[nameEnd]
        if ch.isLetter || ch.isNumber || ch == "_" || ch == "-" {
            nameEnd = afterSlash.index(after: nameEnd)
        } else {
            break
        }
    }
    let name = String(afterSlash[afterSlash.startIndex..<nameEnd])
    guard !name.isEmpty else { return nil }

    // Anything after the name must be whitespace/newline (or end-of-string).
    if nameEnd == afterSlash.endIndex {
        return (name, "")
    }
    let separator = afterSlash[nameEnd]
    guard separator.isWhitespace || separator.isNewline else { return nil }

    // Rest = everything after the first separator character.
    let restStart = afterSlash.index(after: nameEnd)
    let rest = String(afterSlash[restStart..<afterSlash.endIndex])
    return (name, rest)
}

import Foundation

/// Line-based diff for rendering `AcpToolCallDiff` payloads on mobile.
/// Classic LCS over lines — quadratic, so inputs are capped: beyond
/// `maxLines` per side the result degrades to delete-all/insert-all
/// rather than risking a main-thread stall on a pathological edit.
public enum LineDiff {
    public enum Kind: Sendable, Equatable {
        case context
        case insert
        case delete
    }

    public struct Line: Sendable, Equatable {
        public let kind: Kind
        public let text: String

        public init(kind: Kind, text: String) {
            self.kind = kind
            self.text = text
        }
    }

    public static func diff(old: String, new: String, maxLines: Int = 400) -> [Line] {
        let oldLines = splitLines(old)
        let newLines = splitLines(new)

        guard oldLines.count <= maxLines, newLines.count <= maxLines else {
            return oldLines.map { Line(kind: .delete, text: $0) }
                + newLines.map { Line(kind: .insert, text: $0) }
        }

        // LCS length table. lcs[i][j] = LCS of oldLines[i...] and newLines[j...].
        let n = oldLines.count
        let m = newLines.count
        var lcs = Array(repeating: Array(repeating: 0, count: m + 1), count: n + 1)
        for i in stride(from: n - 1, through: 0, by: -1) {
            for j in stride(from: m - 1, through: 0, by: -1) {
                if oldLines[i] == newLines[j] {
                    lcs[i][j] = lcs[i + 1][j + 1] + 1
                } else {
                    lcs[i][j] = max(lcs[i + 1][j], lcs[i][j + 1])
                }
            }
        }

        var result: [Line] = []
        var i = 0
        var j = 0
        while i < n && j < m {
            if oldLines[i] == newLines[j] {
                result.append(Line(kind: .context, text: oldLines[i]))
                i += 1
                j += 1
            } else if lcs[i + 1][j] >= lcs[i][j + 1] {
                result.append(Line(kind: .delete, text: oldLines[i]))
                i += 1
            } else {
                result.append(Line(kind: .insert, text: newLines[j]))
                j += 1
            }
        }
        while i < n { result.append(Line(kind: .delete, text: oldLines[i])); i += 1 }
        while j < m { result.append(Line(kind: .insert, text: newLines[j])); j += 1 }
        return result
    }

    /// Added/removed counts for the summary row ("+12 −3").
    public static func stats(_ lines: [Line]) -> (added: Int, removed: Int) {
        var added = 0
        var removed = 0
        for line in lines {
            switch line.kind {
            case .insert: added += 1
            case .delete: removed += 1
            case .context: break
            }
        }
        return (added, removed)
    }

    /// Splits into logical lines without swallowing a trailing newline into
    /// a phantom empty line. Empty input means zero lines, not one.
    private static func splitLines(_ text: String) -> [String] {
        guard !text.isEmpty else { return [] }
        var lines = text.components(separatedBy: "\n")
        if lines.last == "" { lines.removeLast() }
        return lines
    }
}

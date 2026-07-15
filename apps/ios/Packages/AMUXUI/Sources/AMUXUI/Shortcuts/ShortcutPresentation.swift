import Foundation
import AMUXCore

public enum ShortcutPresentation: Equatable {
    case folder
    case web(URL)
    case disabled

    public static func destination(for node: ShortcutRecord) -> ShortcutPresentation {
        switch node.type {
        case .folder:
            return .folder
        case .native:
            return .disabled
        case .link:
            guard let url = URL(string: node.target),
                  let scheme = url.scheme?.lowercased(),
                  ["http", "https"].contains(scheme) else {
                return .disabled
            }
            return .web(url)
        }
    }
}

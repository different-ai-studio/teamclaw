import SwiftUI
import AMUXCore

public extension TodoItemStatus {
    var rowIcon: String {
        switch self {
        case .completed: "checkmark.circle.fill"
        case .inProgress: "circle.lefthalf.filled"
        case .pending: "circle"
        case .cancelled: "xmark.circle"
        }
    }

    var rowColor: Color {
        switch self {
        case .completed: Color.amux.sage
        case .inProgress: Color.amux.cinnabar
        case .pending, .cancelled: .secondary
        }
    }
}

import SwiftUI
import AMUXSharedUI

public struct StatusBadge: View {
    let status: Int
    public init(status: Int) { self.status = status }
    public var body: some View {
        Text(label).font(.caption2).fontWeight(.medium)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .foregroundStyle(color)
            .liquidGlass(in: Capsule(), interactive: false)
    }
    private var label: String {
        switch status {
        case 1: "Starting"
        case 2: "Active"
        case 3: "Idle"
        case 4: "Error"
        case 5: "Stopped"
        default: "Unknown"
        }
    }
    private var color: Color {
        switch status {
        case 1: .orange
        case 2: .green
        case 3: .secondary
        case 4: .red
        default: .secondary
        }
    }
}

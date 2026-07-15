import SwiftUI
import AMUXCore

/// Small pill that shows the current agent status (Starting / Active / Idle /
/// Error / Stopped). Because Runtime is a SwiftData @Model, the pill re-renders
/// automatically when SessionDetailViewModel writes a new status in response to
/// an Amux_AcpStatusChange event.
public struct AgentStatusPill: View {
    public let runtime: Runtime

    public init(runtime: Runtime) {
        self.runtime = runtime
    }

    public var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
                .breathingOpacity(active: runtime.isActive)
            Text(runtime.statusLabel)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(color.opacity(0.12), in: Capsule())
    }

    private var color: Color {
        switch runtime.status {
        case 1: return .yellow   // Starting
        case 2: return .green    // Active
        case 3: return .secondary // Idle
        case 4: return .red      // Error
        case 5: return .gray     // Stopped
        default: return .secondary
        }
    }
}

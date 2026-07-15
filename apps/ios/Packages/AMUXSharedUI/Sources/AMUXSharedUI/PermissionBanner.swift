import SwiftUI

public struct PermissionBannerView: View {
    let toolName: String
    let description: String
    let requestId: String
    let isResolved: Bool
    let wasGranted: Bool?
    let onGrant: ((String) -> Void)?
    let onDeny: ((String) -> Void)?

    public init(toolName: String, description: String, requestId: String,
                isResolved: Bool = false, wasGranted: Bool? = nil,
                onGrant: ((String) -> Void)?, onDeny: ((String) -> Void)?) {
        self.toolName = toolName; self.description = description; self.requestId = requestId
        self.isResolved = isResolved; self.wasGranted = wasGranted
        self.onGrant = onGrant; self.onDeny = onDeny
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                // Cinnabar shield in place of the iOS-orange lock — the
                // permission banner is the canonical "intent moment" where
                // the design language allows the vermillion seal.
                Image(systemName: "lock.shield").foregroundStyle(Color.amux.cinnabar)
                Text("Permission Request").font(.subheadline).fontWeight(.semibold)
                    .foregroundStyle(Color.amux.onyx)
            }
            Text("\(toolName): \(description)")
                .font(.caption)
                .foregroundStyle(Color.amux.basalt)

            if isResolved {
                HStack(spacing: 6) {
                    Image(systemName: wasGranted == true ? "checkmark.circle.fill" : "xmark.circle.fill")
                        .foregroundStyle(wasGranted == true ? Color.amux.sage : Color.amux.cinnabarDeep)
                    Text(wasGranted == true ? "Allowed" : "Denied")
                        .font(.subheadline).fontWeight(.medium)
                        .foregroundStyle(wasGranted == true ? Color.amux.sage : Color.amux.cinnabarDeep)
                }
            } else {
                HStack(spacing: 12) {
                    Button { onDeny?(requestId) } label: {
                        Text("Deny").font(.subheadline).fontWeight(.medium).frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .foregroundStyle(Color.amux.cinnabarDeep)
                            .background(Color.amux.cinnabarDeep.opacity(0.10), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    Button { onGrant?(requestId) } label: {
                        Text("Allow").font(.subheadline).fontWeight(.medium).frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .foregroundStyle(Color.amux.sage)
                            .background(Color.amux.sage.opacity(0.18), in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color.amux.cinnabar.opacity(0.30), lineWidth: 1)
        )
    }
}

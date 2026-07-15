import SwiftUI
import AMUXCore
import AMUXSharedUI

public struct ConnectionBannerOverlay: View {
    let mqtt: MQTTService
    var onReconnect: (() -> Void)?

    public init(mqtt: MQTTService, onReconnect: (() -> Void)? = nil) {
        self.mqtt = mqtt
        self.onReconnect = onReconnect
    }

    public var body: some View {
        VStack(spacing: 0) {
            ConnectionBanner(
                state: .from(connectionState: mqtt.connectionState),
                onReconnect: onReconnect
            )
            Spacer(minLength: 0)
        }
        .allowsHitTesting(mqtt.connectionState == .disconnected)
    }
}

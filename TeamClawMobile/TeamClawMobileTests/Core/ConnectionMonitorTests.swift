import Combine
import XCTest
@testable import TeamClawMobile

final class ConnectionMonitorTests: XCTestCase {

    private var mockMQTT: MockMQTTService!
    private var monitor: ConnectionMonitor!
    private var cancellables = Set<AnyCancellable>()

    override func setUp() {
        super.setUp()
        mockMQTT = MockMQTTService()
        monitor = ConnectionMonitor(mqttService: mockMQTT)
        cancellables = []
    }

    override func tearDown() {
        cancellables = []
        monitor = nil
        mockMQTT = nil
        super.tearDown()
    }

    // MARK: - Tests

    /// A new monitor should have isDesktopOnline = false.
    func testInitiallyOffline() {
        XCTAssertFalse(monitor.isDesktopOnline)
        XCTAssertNil(monitor.desktopDeviceName)
    }

    /// Simulate status(online:true), verify isDesktopOnline = true and deviceName.
    func testGoesOnlineOnStatusMessage() {
        let expectation = XCTestExpectation(description: "Monitor goes online")

        monitor.$isDesktopOnline
            .dropFirst() // skip initial false
            .sink { isOnline in
                if isOnline {
                    expectation.fulfill()
                }
            }
            .store(in: &cancellables)

        let statusPayload = StatusPayload(online: true, deviceName: "MacBook Pro")
        let message = MQTTMessage(
            id: UUID().uuidString,
            type: .status,
            timestamp: Date().timeIntervalSince1970,
            payload: .status(statusPayload)
        )
        mockMQTT.simulateMessage(message)

        wait(for: [expectation], timeout: 1.0)

        XCTAssertTrue(monitor.isDesktopOnline)
        XCTAssertEqual(monitor.desktopDeviceName, "MacBook Pro")
    }

    /// Go online, then simulate status(online:false), verify offline.
    func testGoesOfflineOnStatusMessage() {
        // First go online
        let onlineExpectation = XCTestExpectation(description: "Monitor goes online first")
        let offlineExpectation = XCTestExpectation(description: "Monitor goes offline")

        var valueCount = 0
        monitor.$isDesktopOnline
            .dropFirst() // skip initial false
            .sink { isOnline in
                valueCount += 1
                if valueCount == 1 && isOnline {
                    onlineExpectation.fulfill()
                } else if valueCount == 2 && !isOnline {
                    offlineExpectation.fulfill()
                }
            }
            .store(in: &cancellables)

        let onlineMessage = MQTTMessage(
            id: UUID().uuidString,
            type: .status,
            timestamp: Date().timeIntervalSince1970,
            payload: .status(StatusPayload(online: true, deviceName: "MacBook Air"))
        )
        mockMQTT.simulateMessage(onlineMessage)

        wait(for: [onlineExpectation], timeout: 1.0)

        let offlineMessage = MQTTMessage(
            id: UUID().uuidString,
            type: .status,
            timestamp: Date().timeIntervalSince1970,
            payload: .status(StatusPayload(online: false, deviceName: nil))
        )
        mockMQTT.simulateMessage(offlineMessage)

        wait(for: [offlineExpectation], timeout: 1.0)

        XCTAssertFalse(monitor.isDesktopOnline)
    }
}

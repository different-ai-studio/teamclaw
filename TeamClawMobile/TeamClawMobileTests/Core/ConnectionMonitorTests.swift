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

    func testInitiallyOffline() {
        XCTAssertFalse(monitor.isDesktopOnline)
        XCTAssertNil(monitor.desktopDeviceName)
    }

    func testGoesOnlineOnStatusMessage() {
        let expectation = XCTestExpectation(description: "Monitor goes online")

        monitor.$isDesktopOnline
            .dropFirst()
            .sink { isOnline in
                if isOnline { expectation.fulfill() }
            }
            .store(in: &cancellables)

        var status = Teamclaw_StatusReport()
        status.online = true
        status.deviceName = "MacBook Pro"
        let msg = ProtoMQTTCoder.makeEnvelope(.statusReport(status))
        mockMQTT.simulateMessage(msg)

        wait(for: [expectation], timeout: 1.0)

        XCTAssertTrue(monitor.isDesktopOnline)
        XCTAssertEqual(monitor.desktopDeviceName, "MacBook Pro")
    }

    func testGoesOfflineOnStatusMessage() {
        let onlineExpectation = XCTestExpectation(description: "Online first")
        let offlineExpectation = XCTestExpectation(description: "Then offline")

        var valueCount = 0
        monitor.$isDesktopOnline
            .dropFirst()
            .sink { isOnline in
                valueCount += 1
                if valueCount == 1 && isOnline { onlineExpectation.fulfill() }
                else if valueCount == 2 && !isOnline { offlineExpectation.fulfill() }
            }
            .store(in: &cancellables)

        var onlineStatus = Teamclaw_StatusReport()
        onlineStatus.online = true
        onlineStatus.deviceName = "MacBook Air"
        mockMQTT.simulateMessage(ProtoMQTTCoder.makeEnvelope(.statusReport(onlineStatus)))

        wait(for: [onlineExpectation], timeout: 1.0)

        var offlineStatus = Teamclaw_StatusReport()
        offlineStatus.online = false
        mockMQTT.simulateMessage(ProtoMQTTCoder.makeEnvelope(.statusReport(offlineStatus)))

        wait(for: [offlineExpectation], timeout: 1.0)

        XCTAssertFalse(monitor.isDesktopOnline)
    }
}

// PushPreferencesTests.swift
import XCTest
@testable import AMUXCore

final class PushPreferencesTests: XCTestCase {
    func testInDndCrossMidnight() {
        let prefs = NotificationPrefs(enabled: true,
                                       dndStartMin: 1320, dndEndMin: 420,
                                       dndTz: "Asia/Shanghai")
        // 23:30 Asia/Shanghai = 15:30 UTC
        let d1 = ISO8601DateFormatter().date(from: "2026-05-17T15:30:00Z")!
        XCTAssertTrue(prefs.isInDndWindow(at: d1))
        // 12:00 Asia/Shanghai = 04:00 UTC
        let d2 = ISO8601DateFormatter().date(from: "2026-05-17T04:00:00Z")!
        XCTAssertFalse(prefs.isInDndWindow(at: d2))
    }

    func testInDndDisabledWhenNil() {
        let prefs = NotificationPrefs(enabled: true,
                                       dndStartMin: nil, dndEndMin: nil,
                                       dndTz: "Asia/Shanghai")
        XCTAssertFalse(prefs.isInDndWindow(at: Date()))
    }
}

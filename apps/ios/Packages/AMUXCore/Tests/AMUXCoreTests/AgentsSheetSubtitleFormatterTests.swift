import XCTest
@testable import AMUXCore

final class AgentsSheetSubtitleFormatterTests: XCTestCase {

    @MainActor
    func test_subtitle_formatsSelectedAndTotal() {
        let subtitle = AgentsSheetSubtitleFormatter.string(selected: 2, total: 5)
        XCTAssertEqual(subtitle, "2 selected · 5 total")
    }

    @MainActor
    func test_subtitle_zeroSelectedRenders() {
        let subtitle = AgentsSheetSubtitleFormatter.string(selected: 0, total: 3)
        XCTAssertEqual(subtitle, "0 selected · 3 total")
    }
}

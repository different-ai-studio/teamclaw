import XCTest
@testable import AMUXCore

final class AgentButtonLabelTests: XCTestCase {
    func test_zeroSelected_returnsNil() {
        XCTAssertNil(AgentButtonLabel.text(selectedDisplayNamesInOrder: []))
    }

    func test_oneSelected_returnsName() {
        XCTAssertEqual(
            AgentButtonLabel.text(selectedDisplayNamesInOrder: ["alice"]),
            "alice"
        )
    }

    func test_multipleSelected_returnsFirstWithMultiplier() {
        XCTAssertEqual(
            AgentButtonLabel.text(selectedDisplayNamesInOrder: ["alice", "bob"]),
            "alice ×2"
        )
    }

    func test_multipleSelected_threeShowsCountThree() {
        XCTAssertEqual(
            AgentButtonLabel.text(selectedDisplayNamesInOrder: ["alice", "bob", "carol"]),
            "alice ×3"
        )
    }
}

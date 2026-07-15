import XCTest
@testable import AMUXSharedUI

final class MarkdownRendererTests: XCTestCase {
    func testPipeTablesRenderAsCodeBlocks() {
        let input = """
        before
        | Name | Value |
        | --- | --- |
        | grep | pattern: MQTT |
        after
        """

        let output = MarkdownRenderer.sanitizedContent(input)

        XCTAssertTrue(output.contains("before\n\n    | Name | Value |"))
        XCTAssertTrue(output.contains("    | --- | --- |"))
        XCTAssertTrue(output.contains("    | grep | pattern: MQTT |\n\nafter"))
    }

    func testPlainPipeTextIsNotChanged() {
        let input = "use `foo | bar` in a shell"

        XCTAssertEqual(MarkdownRenderer.sanitizedContent(input), input)
    }
}

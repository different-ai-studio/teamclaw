import Combine
import XCTest
@testable import TeamClawMobile

final class MessageAggregatorTests: XCTestCase {

    private var aggregator: MessageAggregator!
    private var cancellables = Set<AnyCancellable>()

    override func setUp() {
        super.setUp()
        aggregator = MessageAggregator()
        cancellables = []
    }

    override func tearDown() {
        cancellables = []
        aggregator = nil
        super.tearDown()
    }

    // MARK: - Tests

    /// Feed seq 0, 1, 2 (done:true with full), verify final assembled = full content.
    func testAssemblesChunksInOrder() {
        let messageID = "msg-1"
        let expectation = XCTestExpectation(description: "Receives full content on done")

        var receivedValues: [String] = []

        aggregator.assembledContent(for: messageID)
            .dropFirst() // skip initial empty value
            .sink { value in
                receivedValues.append(value)
                if value == "Hello World Done" {
                    expectation.fulfill()
                }
            }
            .store(in: &cancellables)

        aggregator.feed(messageID: messageID, chunk: makeChunk(seq: 0, delta: "Hello", done: false, full: nil))
        aggregator.feed(messageID: messageID, chunk: makeChunk(seq: 1, delta: " World", done: false, full: nil))
        aggregator.feed(messageID: messageID, chunk: makeChunk(seq: 2, delta: "", done: true, full: "Hello World Done"))

        wait(for: [expectation], timeout: 1.0)

        XCTAssertEqual(receivedValues.last, "Hello World Done")
    }

    /// Feed seq 1 before seq 0, then seq 2 done:true with full — verify final assembled = full content.
    func testHandlesOutOfOrderChunks() {
        let messageID = "msg-2"
        let expectation = XCTestExpectation(description: "Receives full content on done")

        var lastValue: String = ""

        aggregator.assembledContent(for: messageID)
            .dropFirst()
            .sink { value in
                lastValue = value
                if value == "Complete Text" {
                    expectation.fulfill()
                }
            }
            .store(in: &cancellables)

        // Feed out of order: seq 1 before seq 0
        aggregator.feed(messageID: messageID, chunk: makeChunk(seq: 1, delta: " World", done: false, full: nil))
        aggregator.feed(messageID: messageID, chunk: makeChunk(seq: 0, delta: "Hello", done: false, full: nil))
        aggregator.feed(messageID: messageID, chunk: makeChunk(seq: 2, delta: "", done: true, full: "Complete Text"))

        wait(for: [expectation], timeout: 1.0)

        XCTAssertEqual(lastValue, "Complete Text")
    }

    /// Feed partial delta then done with full, verify assembled = full (not assembled deltas).
    func testUsesFullContentOnDone() {
        let messageID = "msg-3"
        let expectation = XCTestExpectation(description: "Uses full content, not assembled deltas")

        var lastValue: String = ""

        aggregator.assembledContent(for: messageID)
            .dropFirst()
            .sink { value in
                lastValue = value
                if value == "Authoritative Full Text" {
                    expectation.fulfill()
                }
            }
            .store(in: &cancellables)

        aggregator.feed(messageID: messageID, chunk: makeChunk(seq: 0, delta: "Partial", done: false, full: nil))
        // done=true with full that differs from assembled deltas
        aggregator.feed(messageID: messageID, chunk: makeChunk(seq: 1, delta: " text", done: true, full: "Authoritative Full Text"))

        wait(for: [expectation], timeout: 1.0)

        XCTAssertEqual(lastValue, "Authoritative Full Text")
        XCTAssertNotEqual(lastValue, "Partial text")
    }

    // MARK: - Helpers

    private func makeChunk(seq: Int, delta: String, done: Bool, full: String?) -> ChatResponsePayload {
        ChatResponsePayload(
            sessionID: "session-1",
            seq: seq,
            delta: delta,
            done: done,
            full: full
        )
    }
}

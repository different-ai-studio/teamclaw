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

    func testAssemblesChunksInOrder() {
        let messageID = "msg-1"
        let expectation = XCTestExpectation(description: "Receives assembled content")

        var receivedValues: [String] = []

        aggregator.assembledContent(for: messageID)
            .dropFirst()
            .sink { value in
                receivedValues.append(value)
                if value == "Hello World" {
                    expectation.fulfill()
                }
            }
            .store(in: &cancellables)

        aggregator.feed(messageID: messageID, chunk: makeDelta(seq: 0, text: "Hello"))
        aggregator.feed(messageID: messageID, chunk: makeDelta(seq: 1, text: " World"))
        aggregator.feed(messageID: messageID, chunk: makeDone(seq: 2))

        wait(for: [expectation], timeout: 1.0)

        XCTAssertEqual(receivedValues.last, "Hello World")
    }

    func testHandlesOutOfOrderChunks() {
        let messageID = "msg-2"
        let expectation = XCTestExpectation(description: "Handles out-of-order")

        var lastValue: String = ""

        aggregator.assembledContent(for: messageID)
            .dropFirst()
            .sink { value in
                lastValue = value
                if value == "Hello World" {
                    expectation.fulfill()
                }
            }
            .store(in: &cancellables)

        aggregator.feed(messageID: messageID, chunk: makeDelta(seq: 1, text: " World"))
        aggregator.feed(messageID: messageID, chunk: makeDelta(seq: 0, text: "Hello"))
        aggregator.feed(messageID: messageID, chunk: makeDone(seq: 2))

        wait(for: [expectation], timeout: 1.0)

        XCTAssertEqual(lastValue, "Hello World")
    }

    func testStreamError() {
        let messageID = "msg-3"
        let expectation = XCTestExpectation(description: "Receives error")

        var lastValue: String = ""

        aggregator.assembledContent(for: messageID)
            .dropFirst()
            .sink { value in
                lastValue = value
                if value.contains("Error") {
                    expectation.fulfill()
                }
            }
            .store(in: &cancellables)

        aggregator.feed(messageID: messageID, chunk: makeDelta(seq: 0, text: "Partial"))
        aggregator.feed(messageID: messageID, chunk: makeError(seq: 1, message: "rate limited"))

        wait(for: [expectation], timeout: 1.0)

        XCTAssertEqual(lastValue, "[Error: rate limited]")
    }

    // MARK: - Helpers

    private func makeDelta(seq: Int, text: String) -> Teamclaw_ChatResponse {
        var resp = Teamclaw_ChatResponse()
        resp.sessionID = "session-1"
        resp.seq = Int32(seq)
        resp.event = .delta(text)
        return resp
    }

    private func makeDone(seq: Int) -> Teamclaw_ChatResponse {
        var resp = Teamclaw_ChatResponse()
        resp.sessionID = "session-1"
        resp.seq = Int32(seq)
        resp.event = .done(Teamclaw_StreamDone())
        return resp
    }

    private func makeError(seq: Int, message: String) -> Teamclaw_ChatResponse {
        var resp = Teamclaw_ChatResponse()
        resp.sessionID = "session-1"
        resp.seq = Int32(seq)
        var err = Teamclaw_StreamError()
        err.message = message
        resp.event = .error(err)
        return resp
    }
}

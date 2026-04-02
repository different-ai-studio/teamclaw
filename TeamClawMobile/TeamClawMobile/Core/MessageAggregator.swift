import Combine
import Foundation

// MARK: - MessageAggregator

/// Assembles streaming Agent responses from MQTT chunks.
/// Desktop sends chunks every 200-300ms with sequential seq numbers.
final class MessageAggregator {

    // MARK: - Private State

    private struct MessageState {
        var chunks: [Int: String] = [:]       // seq → delta
        var isDone: Bool = false
        var fullContent: String? = nil
        var subject = CurrentValueSubject<String, Never>("")
    }

    private var states: [String: MessageState] = [:]
    private let lock = NSLock()

    // MARK: - Public Interface

    /// Returns a publisher that emits the current assembled text each time a chunk arrives.
    func assembledContent(for messageID: String) -> AnyPublisher<String, Never> {
        lock.lock()
        defer { lock.unlock() }

        if states[messageID] == nil {
            states[messageID] = MessageState()
        }
        return states[messageID]!.subject.eraseToAnyPublisher()
    }

    /// Feed a new chunk into the aggregator.
    func feed(messageID: String, chunk: ChatResponsePayload) {
        lock.lock()
        defer { lock.unlock() }

        if states[messageID] == nil {
            states[messageID] = MessageState()
        }

        states[messageID]!.chunks[chunk.seq] = chunk.delta

        if chunk.done, let full = chunk.full {
            states[messageID]!.isDone = true
            states[messageID]!.fullContent = full
            states[messageID]!.subject.send(full)
        } else {
            // Assemble in order from seq 0 upward
            let assembled = assembleInOrder(chunks: states[messageID]!.chunks)
            states[messageID]!.subject.send(assembled)
        }
    }

    /// Clean up internal state for a message.
    func reset(messageID: String) {
        lock.lock()
        defer { lock.unlock() }

        states.removeValue(forKey: messageID)
    }

    // MARK: - Private Helpers

    private func assembleInOrder(chunks: [Int: String]) -> String {
        var result = ""
        var seq = 0
        while let delta = chunks[seq] {
            result += delta
            seq += 1
        }
        return result
    }
}

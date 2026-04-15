import Combine
import Foundation

final class MessageAggregator {

    private struct MessageState {
        var chunks: [Int: String] = [:]
        var isDone: Bool = false
        var subject = CurrentValueSubject<String, Never>("")
    }

    private var states: [String: MessageState] = [:]
    private let lock = NSLock()

    func assembledContent(for messageID: String) -> AnyPublisher<String, Never> {
        lock.lock()
        defer { lock.unlock() }

        if states[messageID] == nil {
            states[messageID] = MessageState()
        }
        return states[messageID]!.subject.eraseToAnyPublisher()
    }

    func feed(messageID: String, chunk: Teamclaw_ChatResponse) {
        lock.lock()
        defer { lock.unlock() }

        if states[messageID] == nil {
            states[messageID] = MessageState()
        }

        switch chunk.event {
        case .delta(let text):
            states[messageID]!.chunks[Int(chunk.seq)] = text
            let assembled = assembleInOrder(chunks: states[messageID]!.chunks)
            states[messageID]!.subject.send(assembled)
        case .done:
            states[messageID]!.isDone = true
            let assembled = assembleInOrder(chunks: states[messageID]!.chunks)
            states[messageID]!.subject.send(assembled)
        case .error(let err):
            states[messageID]!.subject.send("[Error: \(err.message)]")
        case .toolEvent, .hasThinking_p:
            break
        case .none:
            break
        }
    }

    func currentContent(for messageID: String) -> String {
        lock.lock()
        defer { lock.unlock() }
        guard let state = states[messageID] else { return "" }
        return assembleInOrder(chunks: state.chunks)
    }

    func reset(messageID: String) {
        lock.lock()
        defer { lock.unlock() }
        states.removeValue(forKey: messageID)
    }

    private func assembleInOrder(chunks: [Int: String]) -> String {
        guard !chunks.isEmpty else { return "" }
        let maxSeq = chunks.keys.max() ?? 0
        var result = ""
        for seq in 0...maxSeq {
            if let delta = chunks[seq] {
                result += delta
            }
            // Skip gaps (tool events, thinking flags, etc.)
        }
        return result
    }
}

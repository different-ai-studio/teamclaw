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
        case .none:
            break
        }
    }

    func reset(messageID: String) {
        lock.lock()
        defer { lock.unlock() }
        states.removeValue(forKey: messageID)
    }

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

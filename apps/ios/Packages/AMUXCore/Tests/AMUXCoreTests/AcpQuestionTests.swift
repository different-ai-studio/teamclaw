import Foundation
import Testing
@testable import AMUXCore

@Suite("OpenCode question decoding")
struct AcpQuestionTests {
    @Test("decodes option labels, descriptions, and multiple selection")
    @MainActor
    func decodesQuestionPayload() throws {
        let json = #"""
        {
          "id": "question-1",
          "questions": [{
            "header": "选择排序算法",
            "question": "你想要哪种排序算法？",
            "multiple": true,
            "options": [
              {"label": "快速排序", "description": "Recommended"},
              {"label": "归并排序"}
            ]
          }]
        }
        """#

        let pending = SessionDetailViewModel.decodePendingQuestion(
            try #require(json.data(using: .utf8)),
            agentActorID: "agent-1"
        )

        let value = try #require(pending)
        #expect(value.id == "question-1")
        #expect(value.agentActorID == "agent-1")
        #expect(value.questions.count == 1)
        #expect(value.questions[0].allowsMultiple)
        #expect(value.questions[0].options.map(\.label) == ["快速排序", "归并排序"])
        #expect(value.questions[0].options[0].description == "Recommended")
    }
}

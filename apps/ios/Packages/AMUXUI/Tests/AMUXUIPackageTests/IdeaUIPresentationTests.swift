import Testing
@testable import AMUXUI

@Suite("Idea UI presentation")
struct IdeaUIPresentationTests {
    @Test("idea-backed UI presents ideas to users")
    func ideaBackedUIPresentsIdeas() {
        #expect(IdeaUIPresentation.singularTitle == "Idea")
        #expect(IdeaUIPresentation.pluralTitle == "Ideas")
        #expect(IdeaUIPresentation.systemImage == "lightbulb")
    }
}

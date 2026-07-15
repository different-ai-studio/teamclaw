import Testing
import Foundation
@testable import AMUXCore

@Suite("SearchMatcher")
struct SearchMatcherTests {
    @Test func emptyQueryReturnsNoMatch() {
        #expect(SearchMatcher.matches(haystack: "Hello World", query: "") == false)
    }

    @Test func whitespaceOnlyQueryReturnsNoMatch() {
        #expect(SearchMatcher.matches(haystack: "Hello World", query: "   ") == false)
    }

    @Test func caseInsensitiveMatch() {
        #expect(SearchMatcher.matches(haystack: "Hello World", query: "hello"))
        #expect(SearchMatcher.matches(haystack: "Hello World", query: "WORLD"))
    }

    @Test func substringMatch() {
        #expect(SearchMatcher.matches(haystack: "Refactor payment flow", query: "refactor"))
        #expect(SearchMatcher.matches(haystack: "Refactor payment flow", query: "pay"))
    }

    @Test func noMatchReturnsFalse() {
        #expect(SearchMatcher.matches(haystack: "Hello World", query: "banana") == false)
    }

    @Test func nilOrEmptyHaystackReturnsFalse() {
        #expect(SearchMatcher.matches(haystack: "", query: "hi") == false)
    }

    @Test func matchesAnyField() {
        let fields = ["Title One", "Description body", ""]
        #expect(SearchMatcher.matchesAny(fields: fields, query: "body"))
        #expect(SearchMatcher.matchesAny(fields: fields, query: "title"))
        #expect(SearchMatcher.matchesAny(fields: fields, query: "nope") == false)
    }
}

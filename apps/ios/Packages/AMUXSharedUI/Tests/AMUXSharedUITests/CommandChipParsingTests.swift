import Testing
@testable import AMUXSharedUI

@Suite("extractSlashCommand")
struct CommandChipParsingTests {
    @Test("plain command with arguments → split")
    func commandWithArgs() {
        let result = extractSlashCommand("/cmd args here")
        #expect(result?.command == "cmd")
        #expect(result?.rest == "args here")
    }

    @Test("bare command (no args) → empty rest")
    func commandNoArgs() {
        let result = extractSlashCommand("/cmd")
        #expect(result?.command == "cmd")
        #expect(result?.rest == "")
    }

    @Test("command with dash → matches")
    func commandWithDash() {
        let result = extractSlashCommand("/plan-ceo-review now")
        #expect(result?.command == "plan-ceo-review")
        #expect(result?.rest == "now")
    }

    @Test("command with underscore → matches")
    func commandWithUnderscore() {
        let result = extractSlashCommand("/cmd_under value")
        #expect(result?.command == "cmd_under")
        #expect(result?.rest == "value")
    }

    @Test("digit start → nil")
    func digitStart() {
        #expect(extractSlashCommand("/123abc") == nil)
    }

    @Test("bare slash → nil")
    func bareSlash() {
        #expect(extractSlashCommand("/") == nil)
    }

    @Test("no leading slash → nil")
    func noLeadingSlash() {
        #expect(extractSlashCommand("not a command") == nil)
    }

    @Test("leading whitespace → nil")
    func leadingWhitespace() {
        #expect(extractSlashCommand(" /cmd") == nil)
    }

    @Test("multiline body → rest contains newlines")
    func multilineBody() {
        let result = extractSlashCommand("/cmd line one\nline two")
        #expect(result?.command == "cmd")
        #expect(result?.rest == "line one\nline two")
    }

    @Test("empty string → nil")
    func emptyString() {
        #expect(extractSlashCommand("") == nil)
    }
}

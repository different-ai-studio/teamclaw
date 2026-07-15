import Testing
import AMUXCore
@testable import AMUXUI

@Suite("ComposerState decision helpers")
struct ComposerStateTests {

    // MARK: rightButton

    @Test("agent active forces stop, regardless of text or voice state")
    func agentActiveAlwaysStop() {
        #expect(ComposerState.rightButton(isAgentActive: true, hasText: false, voiceState: .idle) == .stop)
        #expect(ComposerState.rightButton(isAgentActive: true, hasText: true,  voiceState: .idle) == .stop)
        #expect(ComposerState.rightButton(isAgentActive: true, hasText: false, voiceState: .recording) == .stop)
        #expect(ComposerState.rightButton(isAgentActive: true, hasText: true,  voiceState: .recording) == .stop)
    }

    @Test("recording shows stopRecording when agent idle")
    func recordingShowsStopRecording() {
        #expect(ComposerState.rightButton(isAgentActive: false, hasText: false, voiceState: .recording) == .stopRecording)
        // recording wins over hasText when agent idle
        #expect(ComposerState.rightButton(isAgentActive: false, hasText: true,  voiceState: .recording) == .stopRecording)
    }

    @Test("idle + non-empty text shows send")
    func idleWithTextShowsSend() {
        #expect(ComposerState.rightButton(isAgentActive: false, hasText: true, voiceState: .idle) == .send)
        #expect(ComposerState.rightButton(isAgentActive: false, hasText: true, voiceState: .done) == .send)
        #expect(ComposerState.rightButton(isAgentActive: false, hasText: true, voiceState: .denied) == .send)
    }

    @Test("idle + empty text shows mic")
    func idleEmptyShowsMic() {
        #expect(ComposerState.rightButton(isAgentActive: false, hasText: false, voiceState: .idle) == .mic)
        #expect(ComposerState.rightButton(isAgentActive: false, hasText: false, voiceState: .done) == .mic)
        #expect(ComposerState.rightButton(isAgentActive: false, hasText: false, voiceState: .denied) == .mic)
        #expect(ComposerState.rightButton(isAgentActive: false, hasText: false, voiceState: .error("oops")) == .mic)
    }

    // MARK: inputMode

    @Test("input shows waveform only while recording")
    func waveformOnlyWhileRecording() {
        #expect(ComposerState.inputMode(voiceState: .recording) == .waveform)
        #expect(ComposerState.inputMode(voiceState: .idle) == .textField)
        #expect(ComposerState.inputMode(voiceState: .done) == .textField)
        #expect(ComposerState.inputMode(voiceState: .denied) == .textField)
        #expect(ComposerState.inputMode(voiceState: .error("x")) == .textField)
    }
}

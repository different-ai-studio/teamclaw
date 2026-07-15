import AMUXCore

enum ComposerRightButton: Equatable {
    case stopRecording // voice recording in progress — finish recording
    case send          // idle, text non-empty
    case mic           // idle, text empty — start recording
}

enum ComposerInputMode: Equatable {
    case textField
    case waveform
}

enum ComposerState {
    /// Right-side button next to the text input. Multi-agent sessions
    /// removed the in-input stop button — interrupts now live on each
    /// agent's chip card above the composer (so you can stop one
    /// runtime without affecting the others).
    static func rightButton(
        hasText: Bool,
        voiceState: VoiceRecorder.State
    ) -> ComposerRightButton {
        if voiceState == .recording { return .stopRecording }
        return hasText ? .send : .mic
    }

    static func inputMode(voiceState: VoiceRecorder.State) -> ComposerInputMode {
        voiceState == .recording ? .waveform : .textField
    }
}

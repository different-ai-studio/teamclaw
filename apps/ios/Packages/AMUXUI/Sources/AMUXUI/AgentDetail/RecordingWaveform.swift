import SwiftUI
import AMUXSharedUI

struct RecordingWaveform: View {
    /// 0...1 normalized current audio level.
    let level: Float
    /// Number of bars to render.
    var barCount: Int = 7

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "waveform")
                .font(.subheadline)
                .foregroundStyle(Color.amux.cinnabarDeep)
                .symbolEffect(.variableColor.iterative.reversing)
            TimelineView(.animation) { context in
                let t = context.date.timeIntervalSinceReferenceDate
                HStack(spacing: 3) {
                    ForEach(0..<barCount, id: \.self) { i in
                        Capsule()
                            .fill(Color.amux.cinnabarDeep.opacity(0.85))
                            .frame(width: 3, height: barHeight(for: i, time: t))
                    }
                }
                .frame(height: 26, alignment: .center)
            }
            Text("Recording…")
                .font(.subheadline)
                .foregroundStyle(Color.amux.basalt)
                .padding(.leading, 6)
            Spacer(minLength: 0)
        }
        .accessibilityLabel("Recording")
    }

    /// Drives a continuous sine wave per bar, scaled and biased by the live
    /// audio level so silent moments still pulse and louder moments swing more.
    private func barHeight(for index: Int, time: TimeInterval) -> CGFloat {
        let l = CGFloat(max(0, min(1, level)))
        let phase = CGFloat(index) / CGFloat(barCount) * .pi * 2
        let wave = sin(time * 6 + phase) * 0.4
        let amplitude = 0.25 + l * 0.6        // baseline pulse + level-driven swing
        let h = max(0.15, min(1.0, amplitude + wave * (0.4 + l * 0.6)))
        return 4 + h * 22
    }
}

#Preview {
    VStack(spacing: 12) {
        RecordingWaveform(level: 0.0)
        RecordingWaveform(level: 0.3)
        RecordingWaveform(level: 0.7)
    }
    .padding()
}

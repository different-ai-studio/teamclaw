import SwiftUI
import AMUXCore
import AMUXSharedUI

#if os(iOS)

// MARK: - TeamStatsSheet

/// Team-wide statistics sheet. Opened from the leading toolbar button in
/// MembersTab. Shows token consumption, session count, and skills invocations
/// across the whole team, plus a per-actor token ranking and a skills
/// breakdown. All data is mock until real aggregates land.
struct TeamStatsSheet: View {
    @Environment(\.dismiss) private var dismiss
    let actors: [CachedActor]

    enum Period: String, CaseIterable {
        case today = "Today"
        case week  = "Week"
        case month = "Month"
        case all   = "All"
    }

    @State private var period: Period = .week

    // MARK: Mock data (stable per actor hash)

    private struct ActorStat: Identifiable {
        let id: String
        let name: String
        let isAgent: Bool
        let isOnline: Bool
        let agentType: String?
        let tokens: Int
    }

    private var actorStats: [ActorStat] {
        actors
            .filter { $0.isMember || $0.isAgent }
            .map { a in
                let h = abs(a.actorId.unicodeScalars.reduce(0) { $0 &+ Int($1.value) })
                let periodMult: Int
                switch period {
                case .today: periodMult = 1
                case .week:  periodMult = 7
                case .month: periodMult = 30
                case .all:   periodMult = 90
                }
                let base = [8_200, 14_400, 22_100, 31_500, 47_800, 68_000, 112_300][h % 7]
                return ActorStat(
                    id: a.actorId,
                    name: a.displayName,
                    isAgent: a.isAgent,
                    isOnline: a.isOnline,
                    agentType: a.defaultAgentType,
                    tokens: base * periodMult / 7
                )
            }
            .sorted { $0.tokens > $1.tokens }
    }

    private var totalTokens: Int { actorStats.reduce(0) { $0 + $1.tokens } }

    private var totalSessions: Int {
        switch period {
        case .today: return 6
        case .week:  return 42
        case .month: return 178
        case .all:   return 534
        }
    }

    private var totalSkills: Int {
        switch period {
        case .today: return 38
        case .week:  return 386
        case .month: return 1_642
        case .all:   return 4_920
        }
    }

    private struct SkillStat: Identifiable {
        let id = UUID()
        let name: String
        let count: Int
    }

    private var topSkills: [SkillStat] {
        let bases: [(String, Int)] = [
            ("Read",  142),
            ("Edit",   88),
            ("Bash",   54),
            ("Write",  32),
            ("Grep",   24),
        ]
        let periodMult: Int
        switch period {
        case .today: periodMult = 1
        case .week:  periodMult = 7
        case .month: periodMult = 30
        case .all:   periodMult = 90
        }
        return bases.map { SkillStat(name: $0.0, count: $0.1 * periodMult / 7) }
    }

    private var maxSkillCount: Int { max(1, topSkills.map(\.count).max() ?? 1) }

    // MARK: Body

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    periodPicker
                    summaryRow
                    rankingSection
                    skillsSection
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 32)
            }
            .background(Color.amux.mist)
            .navigationTitle("Team Statistics")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(Color.amux.onyx)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    // MARK: Period picker

    private var periodPicker: some View {
        Picker("Period", selection: $period) {
            ForEach(Period.allCases, id: \.self) { p in
                Text(p.rawValue).tag(p)
            }
        }
        .pickerStyle(.segmented)
    }

    // MARK: Summary cards

    private var summaryRow: some View {
        HStack(spacing: 10) {
            summaryCard(
                label: "TOKENS",
                value: formattedTokens(totalTokens),
                icon: "sparkles"
            )
            summaryCard(
                label: "SESSIONS",
                value: "\(totalSessions)",
                icon: "bubble.left.and.bubble.right"
            )
            summaryCard(
                label: "SKILLS",
                value: "\(totalSkills)",
                icon: "hammer"
            )
        }
    }

    private func summaryCard(label: String, value: String, icon: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(Color.amux.basalt)
            Text(value)
                .font(.system(size: 20, weight: .bold, design: .monospaced))
                .foregroundStyle(Color.amux.onyx)
                .monospacedDigit()
                .minimumScaleFactor(0.7)
                .lineLimit(1)
            Text(label)
                .font(.system(size: 9, weight: .semibold))
                .tracking(0.4)
                .foregroundStyle(Color.amux.slate)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.amux.paper)
        )
    }

    // MARK: Token ranking

    private var rankingSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionEyebrow("TOKEN RANKING")

            VStack(spacing: 0) {
                ForEach(Array(actorStats.enumerated()), id: \.element.id) { idx, stat in
                    rankRow(rank: idx + 1, stat: stat)
                    if idx < actorStats.count - 1 {
                        Divider()
                            .overlay(Color.amux.hairline)
                            .padding(.leading, 44)
                    }
                }
            }
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.amux.paper)
            )
        }
    }

    private func rankRow(rank: Int, stat: ActorStat) -> some View {
        HStack(spacing: 10) {
            // Rank number
            Text("\(rank)")
                .font(.system(size: 12, weight: .bold, design: .monospaced))
                .foregroundStyle(rank == 1 ? Color.amux.cinnabar : Color.amux.slate)
                .frame(width: 18, alignment: .center)

            // Avatar dot
            actorDot(stat: stat)

            // Name
            Text(stat.name)
                .font(.subheadline)
                .foregroundStyle(Color.amux.onyx)
                .lineLimit(1)

            Spacer(minLength: 8)

            // Token count
            Text(formattedTokens(stat.tokens))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(rank == 1 ? Color.amux.cinnabar : Color.amux.basalt)
                .monospacedDigit()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(rank == 1 ? Color.amux.cinnabar.opacity(0.04) : Color.clear)
    }

    private func actorDot(stat: ActorStat) -> some View {
        ZStack {
            if stat.isAgent {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color.amux.pebble)
                    .frame(width: 26, height: 26)
                    .overlay(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .stroke(Color.amux.hairline, lineWidth: 0.5)
                    )
            } else {
                Circle()
                    .fill(agentColor(for: stat))
                    .frame(width: 26, height: 26)
            }
            Text(initials(stat.name))
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(stat.isAgent ? agentGlyphColor(for: stat) : Color.white)
        }
    }

    // MARK: Skills breakdown

    private var skillsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionEyebrow("SKILLS USAGE")

            VStack(spacing: 0) {
                ForEach(Array(topSkills.enumerated()), id: \.element.id) { idx, skill in
                    skillRow(skill: skill)
                    if idx < topSkills.count - 1 {
                        Divider()
                            .overlay(Color.amux.hairline)
                            .padding(.leading, 14)
                    }
                }
            }
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.amux.paper)
            )
        }
    }

    private func skillRow(skill: SkillStat) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(skill.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.amux.onyx)
                Spacer()
                Text("\(skill.count)")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(Color.amux.basalt)
                    .monospacedDigit()
            }
            GeometryReader { proxy in
                let ratio = maxSkillCount > 0
                    ? CGFloat(skill.count) / CGFloat(maxSkillCount)
                    : 0
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.amux.pebble)
                    Capsule()
                        .fill(LinearGradient(
                            colors: [Color.amux.pebble, Color.amux.cinnabar],
                            startPoint: .leading,
                            endPoint: .trailing
                        ))
                        .frame(width: proxy.size.width * ratio)
                }
            }
            .frame(height: 4)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    // MARK: Helpers

    private func sectionEyebrow(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 11, weight: .semibold))
            .tracking(0.35)
            .foregroundStyle(Color.amux.basalt.opacity(0.7))
    }

    private func formattedTokens(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000     { return String(format: "%.1fK", Double(n) / 1_000) }
        return "\(n)"
    }

    private func initials(_ name: String) -> String {
        let parts = name.split(whereSeparator: { $0.isWhitespace }).prefix(2)
        let result = parts.compactMap { $0.first }.map(String.init).joined().uppercased()
        return result.isEmpty ? String(name.prefix(1)).uppercased() : result
    }

    private func agentColor(for stat: ActorStat) -> Color {
        let palette: [Color] = [Color.amux.basalt, Color.amux.slate, Color.amux.sage, Color.amux.onyx]
        let h = abs(stat.id.unicodeScalars.reduce(0) { $0 &+ Int($1.value) })
        return palette[h % palette.count]
    }

    private func agentGlyphColor(for stat: ActorStat) -> Color {
        switch stat.agentType {
        case "claude", "claude_code": return Color.amux.cinnabar
        case "opencode":              return Color.amux.sage
        case "codex":                 return Color.amux.basalt
        default:                      return Color.amux.basalt
        }
    }
}

#endif

import Foundation

/// One row of `GET /v1/teams/:id/leaderboard` — per-actor aggregates for a
/// period. The same rows back the team stats sheet's totals (summed) and
/// the per-actor ranking.
public struct TeamLeaderboardEntry: Sendable, Equatable {
    public let actorID: String
    public let displayName: String?
    public let tokensUsed: Double
    public let costUsd: Double
    public let sessionCount: Int
    public let positiveFeedback: Int
    public let negativeFeedback: Int
    public let skillUsage: [String: Int]

    public init(actorID: String, displayName: String?, tokensUsed: Double,
                costUsd: Double, sessionCount: Int, positiveFeedback: Int,
                negativeFeedback: Int, skillUsage: [String: Int]) {
        self.actorID = actorID
        self.displayName = displayName
        self.tokensUsed = tokensUsed
        self.costUsd = costUsd
        self.sessionCount = sessionCount
        self.positiveFeedback = positiveFeedback
        self.negativeFeedback = negativeFeedback
        self.skillUsage = skillUsage
    }
}

public protocol TelemetryRepository: Sendable {
    /// `period` is `day | week | month` (server default: week).
    func leaderboard(teamID: String, period: String) async throws -> [TeamLeaderboardEntry]
}

public actor CloudAPITelemetryRepository: TelemetryRepository {
    private let client: CloudAPIClient

    public init(client: CloudAPIClient) {
        self.client = client
    }

    public func leaderboard(teamID: String, period: String) async throws -> [TeamLeaderboardEntry] {
        let encodedTeam = teamID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? teamID
        let encodedPeriod = period.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? period
        let page: CloudLeaderboardPage = try await client.get(
            "/v1/teams/\(encodedTeam)/leaderboard?period=\(encodedPeriod)"
        )
        return page.items.map {
            TeamLeaderboardEntry(
                actorID: $0.actorId,
                displayName: $0.displayName,
                tokensUsed: $0.tokensUsed ?? 0,
                costUsd: $0.costUsd ?? 0,
                sessionCount: $0.sessionCount ?? 0,
                positiveFeedback: $0.positiveFeedback ?? 0,
                negativeFeedback: $0.negativeFeedback ?? 0,
                skillUsage: $0.skillUsage ?? [:]
            )
        }
    }
}

private struct CloudLeaderboardPage: Decodable, Sendable {
    struct Row: Decodable, Sendable {
        let actorId: String
        let displayName: String?
        let tokensUsed: Double?
        let costUsd: Double?
        let sessionCount: Int?
        let positiveFeedback: Int?
        let negativeFeedback: Int?
        let skillUsage: [String: Int]?
    }
    let items: [Row]
}

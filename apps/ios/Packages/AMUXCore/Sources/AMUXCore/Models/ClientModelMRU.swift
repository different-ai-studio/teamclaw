import Foundation

/// This install's most-recently-used models — the answer to "which model should
/// a new chat start on?"
///
/// # Why this is here and not in the daemon
///
/// It used to live in amuxd (`config::model_mru`), put there because gateway and
/// cron runtimes start inside the daemon and can never read a client's storage.
/// That held, but it made amuxd the owner of a *preference*, and a preference is
/// something a mis-picking client can poison: a cold-start client wrote whatever
/// the catalog listed first, the daemon recorded that run, and every later new
/// session inherited it.
///
/// ADR-0007 removes the need: cron jobs and gateway channels now pin a model when
/// they are created, so nothing inside the daemon has to guess, and the MRU goes
/// back to being a per-client convenience.
///
/// # Why the key is (backend, team)
///
/// Model ids are backend-local — an opencode id means nothing to pi — so the
/// backend must be in the key or a backend switch leaves a list that can never
/// match. Team is in the key because it is the only thing catalogs actually vary
/// by: auditing 15 worktrees on one device traced every difference to the team's
/// LiteLLM gateway models or to probe staleness, none to the directory
/// (#742 decision 3).
///
/// # Scope
///
/// Per install, deliberately. ADR-0007 accepts that iOS and the desktop each keep
/// their own list and never converge — this is a preference, not a promise.
///
/// `@unchecked Sendable` is safe: the only stored property is `UserDefaults`,
/// which Apple documents as thread-safe.
public final class ClientModelMRU: @unchecked Sendable {
    /// Matches the desktop's cap and the daemon's before it. Long enough to
    /// survive a couple of dead providers, short enough to stay comprehensible.
    static let maxRecent = 10

    private static let storageKey = "amux.client-model-mru.v1"

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    private static func key(backend: String, teamID: String) -> String {
        "\(backend.trimmed)::\(teamID.trimmed)"
    }

    /// Recent models for `(backend, team)`, most recently used first.
    public func recent(backend: String, teamID: String) -> [String] {
        let backend = backend.trimmed
        let teamID = teamID.trimmed
        guard !backend.isEmpty, !teamID.isEmpty else { return [] }
        return stored()[Self.key(backend: backend, teamID: teamID)] ?? []
    }

    /// Record a model the user actually chose.
    ///
    /// Only **explicit** picks belong here. Recording an auto-selection turns a
    /// cold-start guess into a preference that outlives the guess — the loop
    /// ADR-0007 exists to break.
    public func record(backend: String, teamID: String, model: String) {
        let backend = backend.trimmed
        let teamID = teamID.trimmed
        let model = model.trimmed
        guard !backend.isEmpty, !teamID.isEmpty, !model.isEmpty else { return }

        let mapKey = Self.key(backend: backend, teamID: teamID)
        var map = stored()
        let next = Self.promote(map[mapKey] ?? [], model)
        guard next != map[mapKey] else { return }
        map[mapKey] = next
        defaults.set(map, forKey: Self.storageKey)
    }

    /// First remembered model the live catalog still offers, or `nil`.
    ///
    /// This is why the MRU is a list rather than one value: the thing a single
    /// "last used" names can stop working — a provider logged out, a key expired,
    /// a model retired — and pinning something that cannot run is worse than
    /// falling through. Mirrors the daemon's `model_mru::first_available`.
    ///
    /// An empty `available` means the catalog has not arrived, NOT that nothing
    /// is runnable, so it answers `nil` rather than guessing.
    public func firstAvailable(
        backend: String,
        teamID: String,
        available: [String]
    ) -> String? {
        guard !available.isEmpty else { return nil }
        let offered = Set(available.map(\.trimmed).filter { !$0.isEmpty })
        return recent(backend: backend, teamID: teamID).first { offered.contains($0) }
    }

    /// Drop everything. Test seam, and the hook a future "forget my preferences"
    /// would use.
    public func clear() {
        defaults.removeObject(forKey: Self.storageKey)
    }

    private func stored() -> [String: [String]] {
        defaults.dictionary(forKey: Self.storageKey) as? [String: [String]] ?? [:]
    }

    /// Move `model` to the front, capped. Returns the input unchanged when it is
    /// already the head, so the caller can skip the write.
    static func promote(_ recent: [String], _ model: String) -> [String] {
        guard recent.first != model else { return recent }
        return Array(([model] + recent.filter { $0 != model }).prefix(maxRecent))
    }
}

private extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

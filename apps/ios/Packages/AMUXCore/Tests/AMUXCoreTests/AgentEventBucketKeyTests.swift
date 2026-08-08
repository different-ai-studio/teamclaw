import XCTest
@testable import AMUXCore

/// Agent events bucket by `Envelope.actor_id`.
///
/// These replace `SessionDetailViewModelRelabelTests`, which covered a
/// reconciliation pass that no longer exists. That pass was needed because
/// events were stamped with the daemon's per-spawn `runtime_id`, a value no
/// topic publishes and no client can map to an agent — so early events landed
/// in a raw-id bucket and had to be rewritten once the roster loaded.
///
/// `actor_id` rides the same envelope, is stable across restarts, and is the
/// value the daemon persists as `sender_actor_id`. Live events and seeded
/// history therefore share a bucket by construction, and there is nothing to
/// reconcile.
@MainActor
final class AgentEventBucketKeyTests: XCTestCase {

    func test_bucketKey_isTheActorIdVerbatim() {
        let vm = SessionDetailViewModel.testInstance()
        let actorID = "eba7abb1-c131-4e31-9ae6-0fe1aced3c94"
        XCTAssertEqual(vm._test_bucketKey(forRuntimeID: actorID), actorID,
            "the wire value is already the bucket key; no resolution step remains")
    }

    func test_bucketKey_rejectsEmptyAndWhitespace() {
        let vm = SessionDetailViewModel.testInstance()
        XCTAssertNil(vm._test_bucketKey(forRuntimeID: ""))
        XCTAssertNil(vm._test_bucketKey(forRuntimeID: "   "),
            "a blank actor id must not create a bucket named by whitespace")
    }

    func test_bucketKey_doesNotCollapseDistinctAgents() {
        // The old freeze-on-first-resolve cache could map two agents onto one
        // bucket while the roster was still loading, merging their turns.
        let vm = SessionDetailViewModel.testInstance()
        XCTAssertNotEqual(vm._test_bucketKey(forRuntimeID: "actor-a"),
                          vm._test_bucketKey(forRuntimeID: "actor-b"))
    }
}

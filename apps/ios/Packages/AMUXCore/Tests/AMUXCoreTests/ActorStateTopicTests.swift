import Testing
@testable import AMUXCore

@Suite("Actor state topic")
struct ActorStateTopicTests {
    private let team = "7f13da11-7d12-4732-a85e-4c4dfdab61d9"

    @Test("matches the one retained topic per actor")
    func matchesActorState() {
        let actor = "eba7abb1-c131-4e31-9ae6-0fe1aced3c94"
        #expect(
            SessionListViewModel.parseActorStateTopic(
                "amux/\(team)/\(actor)/state", teamID: team
            ) == actor
        )
    }

    @Test("does not match the retired per-spawn runtime topic")
    func rejectsRuntimeState() {
        // The daemon stopped publishing this shape and we stopped subscribing,
        // but the broker can still hold retains from an older daemon. Parsing
        // one as actor state would decode a RuntimeInfo as an ActorPresence.
        let topic = "amux/\(team)/eba7abb1/runtime/6369759d/state"
        #expect(SessionListViewModel.parseActorStateTopic(topic, teamID: team) == nil)
    }

    @Test("rejects another team's actor")
    func rejectsForeignTeam() {
        // The broker is shared, so a topic filter is not a team boundary.
        #expect(
            SessionListViewModel.parseActorStateTopic(
                "amux/some-other-team/actor-1/state", teamID: team
            ) == nil
        )
    }

    @Test("rejects malformed topics")
    func rejectsMalformed() {
        for topic in [
            "amux/\(team)/actor-1",              // too few segments
            "amux/\(team)/actor-1/state/extra",  // too many
            "other/\(team)/actor-1/state",       // wrong root
            "amux/\(team)/actor-1/live",         // wrong leaf
        ] {
            #expect(
                SessionListViewModel.parseActorStateTopic(topic, teamID: team) == nil,
                "\(topic) should not parse"
            )
        }
    }
}

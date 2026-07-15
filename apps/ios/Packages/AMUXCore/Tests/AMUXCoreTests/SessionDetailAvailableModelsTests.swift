import XCTest
@testable import AMUXCore

@MainActor
final class SessionDetailAvailableModelsTests: XCTestCase {

    // MARK: - scheduleSpawningRefresh covers active+empty

    func test_needsSpawningPoll_trueForActiveAgentWithEmptyModels() {
        let vm = SessionDetailViewModel.testInstance()
        let agent = MemberSheetAgent(
            id: "agent-a", displayName: "Claude", workspacePath: "",
            agentType: "Claude", runtimeState: .active,
            availableModels: [],
            currentModel: nil, runtimeID: "rid-1",
            workspaceID: nil, backendType: "claude"
        )
        vm._test_setMemberSheetAgents([agent])
        XCTAssertTrue(vm._test_needsSpawningPoll(),
            "active agent with empty availableModels should trigger a refresh poll")
    }

    func test_needsSpawningPoll_falseWhenModelsPresent() {
        let vm = SessionDetailViewModel.testInstance()
        let agent = MemberSheetAgent(
            id: "agent-a", displayName: "Claude", workspacePath: "",
            agentType: "Claude", runtimeState: .active,
            availableModels: ["claude-sonnet-4-6"],
            currentModel: "claude-sonnet-4-6", runtimeID: "rid-1",
            workspaceID: nil, backendType: "claude"
        )
        vm._test_setMemberSheetAgents([agent])
        XCTAssertFalse(vm._test_needsSpawningPoll(),
            "active agent with populated availableModels must NOT trigger redundant poll")
    }

    // MARK: - partial retain: existing models preserved when overlay has empty runtime

    func test_applyPartialRetain_preservesModels_whenRuntimeEmpty() {
        let existing = ["claude-haiku-4-5", "claude-sonnet-4-6"]
        let liveFromRuntime: [String] = []  // runtime 没有 models（STARTING 阶段）
        let result = SessionDetailViewModel._test_mergeAvailableModels(
            liveModels: liveFromRuntime,
            existingModels: existing
        )
        XCTAssertEqual(result, existing,
            "if runtime has no models, existing fallback models must be preserved")
    }

    func test_applyPartialRetain_usesRuntimeModels_whenNonEmpty() {
        let existing = ["claude-haiku-4-5"]
        let liveFromRuntime = ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-7"]
        let result = SessionDetailViewModel._test_mergeAvailableModels(
            liveModels: liveFromRuntime,
            existingModels: existing
        )
        XCTAssertEqual(result, liveFromRuntime,
            "when runtime has models, use them (they are more authoritative)")
    }
}

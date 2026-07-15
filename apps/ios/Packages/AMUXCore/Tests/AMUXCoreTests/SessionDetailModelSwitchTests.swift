import XCTest
@testable import AMUXCore

@MainActor
final class SessionDetailModelSwitchTests: XCTestCase {

    func test_setModel_optimisticallyUpdatesMemberSheet_beforeRpcReturns() async {
        let vm = SessionDetailViewModel.testInstance()
        let agent = MemberSheetAgent(
            id: "agent-a", displayName: "Claude", workspacePath: "",
            agentType: "Claude", runtimeState: .active,
            availableModels: ["claude-haiku-4-5", "claude-sonnet-4-6"],
            currentModel: "claude-haiku-4-5", runtimeID: "rid-1",
            workspaceID: nil, backendType: "claude"
        )
        vm._test_setMemberSheetAgents([agent])

        vm._test_applyOptimisticModelPatch(agentID: "agent-a", model: "claude-sonnet-4-6")

        let updated = vm.memberSheetAgents.first(where: { $0.id == "agent-a" })
        XCTAssertEqual(updated?.currentModel, "claude-sonnet-4-6",
            "currentModel must be patched optimistically without waiting for RPC")
    }

    func test_setModel_rollsBackOptimisticPatch_onRpcFailure() async {
        let vm = SessionDetailViewModel.testInstance()
        let agent = MemberSheetAgent(
            id: "agent-a", displayName: "Claude", workspacePath: "",
            agentType: "Claude", runtimeState: .active,
            availableModels: ["claude-haiku-4-5", "claude-sonnet-4-6"],
            currentModel: "claude-haiku-4-5", runtimeID: "rid-1",
            workspaceID: nil, backendType: "claude"
        )
        vm._test_setMemberSheetAgents([agent])
        vm._test_applyOptimisticModelPatch(agentID: "agent-a", model: "claude-sonnet-4-6")

        vm._test_rollbackOptimisticModelPatch(agentID: "agent-a", previousModel: "claude-haiku-4-5")

        let reverted = vm.memberSheetAgents.first(where: { $0.id == "agent-a" })
        XCTAssertEqual(reverted?.currentModel, "claude-haiku-4-5",
            "currentModel must revert to previous value after RPC failure")
    }
}

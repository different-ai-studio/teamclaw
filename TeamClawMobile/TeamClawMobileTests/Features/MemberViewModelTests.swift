import XCTest
import SwiftData
@testable import TeamClawMobile

@MainActor
final class MemberViewModelTests: XCTestCase {

    var container: ModelContainer!
    var context: ModelContext!
    var mockMQTT: MockMQTTService!

    override func setUp() {
        super.setUp()
        let config = ModelConfiguration(isStoredInMemoryOnly: true)
        container = try! ModelContainer(
            for: Session.self, ChatMessage.self, TeamMember.self, AutomationTask.self, Skill.self, Talent.self,
            configurations: config
        )
        context = container.mainContext
        mockMQTT = MockMQTTService()
    }

    override func tearDown() {
        context = nil
        container = nil
        mockMQTT = nil
        super.tearDown()
    }

    private func makeVM() -> MemberViewModel {
        MemberViewModel(modelContext: context, mqttService: mockMQTT)
    }

    // MARK: - Initial State

    func testInitiallyEmpty() {
        let vm = makeVM()
        XCTAssertTrue(vm.members.isEmpty)
    }

    // MARK: - Sync Response

    func testMemberSyncPopulatesList() {
        let vm = makeVM()

        var member = Teamclaw_MemberData()
        member.id = "m1"
        member.name = "Alice"
        member.avatarURL = ""
        member.isAiAlly = false
        member.note = ""

        var pg = Teamclaw_PageInfo()
        pg.page = 1; pg.pageSize = 50; pg.total = 1

        var resp = Teamclaw_MemberSyncResponse()
        resp.members = [member]
        resp.pagination = pg

        mockMQTT.simulateMessage(ProtoMQTTCoder.makeEnvelope(.memberSyncResponse(resp)))

        let exp = expectation(description: "Members loaded")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            XCTAssertEqual(vm.members.count, 1)
            XCTAssertEqual(vm.members[0].name, "Alice")
            exp.fulfill()
        }
        wait(for: [exp], timeout: 1.0)
    }

    func testMemberSyncReplacesExisting() {
        let vm = makeVM()

        // Insert initial member
        context.insert(TeamMember(id: "m1", name: "Old Name"))
        try? context.save()

        var member = Teamclaw_MemberData()
        member.id = "m1"
        member.name = "New Name"
        member.avatarURL = ""
        member.note = ""

        var pg = Teamclaw_PageInfo()
        pg.page = 1; pg.pageSize = 50; pg.total = 1

        var resp = Teamclaw_MemberSyncResponse()
        resp.members = [member]
        resp.pagination = pg

        mockMQTT.simulateMessage(ProtoMQTTCoder.makeEnvelope(.memberSyncResponse(resp)))

        let exp = expectation(description: "Members replaced")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            XCTAssertEqual(vm.members.count, 1)
            XCTAssertEqual(vm.members[0].name, "New Name")
            exp.fulfill()
        }
        wait(for: [exp], timeout: 1.0)
    }

    func testPaginationRequestsNextPage() {
        // Set fake credentials for publish to work
        setFakePairingCredentials()
        defer { clearFakePairingCredentials() }

        let vm = makeVM()

        var member = Teamclaw_MemberData()
        member.id = "m1"
        member.name = "Alice"
        member.avatarURL = ""
        member.note = ""

        var pg = Teamclaw_PageInfo()
        pg.page = 1; pg.pageSize = 1; pg.total = 2

        var resp = Teamclaw_MemberSyncResponse()
        resp.members = [member]
        resp.pagination = pg

        mockMQTT.simulateMessage(ProtoMQTTCoder.makeEnvelope(.memberSyncResponse(resp)))

        let exp = expectation(description: "Next page requested")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            let syncCalls = self.mockMQTT.publishCalls.filter {
                if case .memberSyncRequest(let req) = $0.message.payload {
                    return req.pagination.page == 2
                }
                return false
            }
            XCTAssertEqual(syncCalls.count, 1)
            exp.fulfill()
        }
        wait(for: [exp], timeout: 1.0)
    }
}

private func setFakePairingCredentials() {
    let ud = UserDefaults.standard
    ud.set(true, forKey: "teamclaw_is_paired")
    ud.set("test-host", forKey: "teamclaw_mqtt_host")
    ud.set(8883, forKey: "teamclaw_mqtt_port")
    ud.set("test-user", forKey: "teamclaw_mqtt_username")
    ud.set("test-pass", forKey: "teamclaw_mqtt_password")
    ud.set("test-team", forKey: "teamclaw_team_id")
    ud.set("test-device", forKey: "teamclaw_device_id")
    ud.set("test-desktop", forKey: "teamclaw_desktop_device_id")
    ud.set("Test Desktop", forKey: "teamclaw_paired_device_name")
}

private func clearFakePairingCredentials() {
    ["teamclaw_is_paired", "teamclaw_mqtt_host", "teamclaw_mqtt_port",
     "teamclaw_mqtt_username", "teamclaw_mqtt_password", "teamclaw_team_id",
     "teamclaw_device_id", "teamclaw_desktop_device_id", "teamclaw_paired_device_name"]
        .forEach { UserDefaults.standard.removeObject(forKey: $0) }
}

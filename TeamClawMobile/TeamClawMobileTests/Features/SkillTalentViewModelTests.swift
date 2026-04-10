import XCTest
import SwiftData
@testable import TeamClawMobile

@MainActor
final class SkillViewModelTests: XCTestCase {

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
        context = nil; container = nil; mockMQTT = nil
        super.tearDown()
    }

    func testSkillSyncPopulatesList() {
        let vm = { let vm = SkillViewModel(mqttService: mockMQTT); vm.setModelContext(context); return vm }()

        var skill = Teamclaw_SkillData()
        skill.id = "s1"
        skill.name = "Auto Translate"
        skill.description_p = "Translates text"
        skill.isPersonal = false
        skill.isEnabled = true

        var pg = Teamclaw_PageInfo()
        pg.page = 1; pg.pageSize = 50; pg.total = 1

        var resp = Teamclaw_SkillSyncResponse()
        resp.skills = [skill]
        resp.pagination = pg

        mockMQTT.simulateMessage(ProtoMQTTCoder.makeEnvelope(.skillSyncResponse(resp)))

        let exp = expectation(description: "Skills loaded")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            XCTAssertEqual(vm.teamSkills.count, 1)
            XCTAssertEqual(vm.teamSkills[0].name, "Auto Translate")
            XCTAssertTrue(vm.personalSkills.isEmpty)
            exp.fulfill()
        }
        wait(for: [exp], timeout: 1.0)
    }

    func testPersonalSkillsSeparated() {
        let vm = { let vm = SkillViewModel(mqttService: mockMQTT); vm.setModelContext(context); return vm }()

        var personal = Teamclaw_SkillData()
        personal.id = "s1"; personal.name = "My Skill"; personal.description_p = ""
        personal.isPersonal = true; personal.isEnabled = true

        var team = Teamclaw_SkillData()
        team.id = "s2"; team.name = "Team Skill"; team.description_p = ""
        team.isPersonal = false; team.isEnabled = true

        var pg = Teamclaw_PageInfo()
        pg.page = 1; pg.pageSize = 50; pg.total = 2

        var resp = Teamclaw_SkillSyncResponse()
        resp.skills = [personal, team]
        resp.pagination = pg

        mockMQTT.simulateMessage(ProtoMQTTCoder.makeEnvelope(.skillSyncResponse(resp)))

        let exp = expectation(description: "Skills split")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            XCTAssertEqual(vm.personalSkills.count, 1)
            XCTAssertEqual(vm.teamSkills.count, 1)
            exp.fulfill()
        }
        wait(for: [exp], timeout: 1.0)
    }
}

@MainActor
final class TalentViewModelTests: XCTestCase {

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
        context = nil; container = nil; mockMQTT = nil
        super.tearDown()
    }

    func testTalentSyncPopulatesList() {
        let vm = { let vm = TalentViewModel(mqttService: mockMQTT); vm.setModelContext(context); return vm }()

        var talent = Teamclaw_TalentData()
        talent.id = "java-reviewer"
        talent.name = "Java Reviewer"
        talent.description_p = "Reviews Java code"
        talent.category = "Role"
        talent.role = "Expert Java code reviewer"
        talent.whenToUse = "When reviewing Java PRs"
        talent.workingStyle = "Strict, follows SOLID"

        var pg = Teamclaw_PageInfo()
        pg.page = 1; pg.pageSize = 50; pg.total = 1

        var resp = Teamclaw_TalentSyncResponse()
        resp.talents = [talent]
        resp.pagination = pg

        mockMQTT.simulateMessage(ProtoMQTTCoder.makeEnvelope(.talentSyncResponse(resp)))

        let exp = expectation(description: "Talents loaded")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            XCTAssertEqual(vm.talents.count, 1)
            XCTAssertEqual(vm.talents[0].name, "Java Reviewer")
            XCTAssertEqual(vm.talents[0].role, "Expert Java code reviewer")
            XCTAssertEqual(vm.talents[0].whenToUse, "When reviewing Java PRs")
            XCTAssertEqual(vm.talents[0].workingStyle, "Strict, follows SOLID")
            exp.fulfill()
        }
        wait(for: [exp], timeout: 1.0)
    }
}

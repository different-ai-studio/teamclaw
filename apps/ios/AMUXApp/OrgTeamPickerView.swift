import SwiftUI
import AMUXCore

/// Shown at login when the user belongs to more than one team (across orgs) and
/// has no remembered choice. Two-level: teams grouped by org. Picking one calls
/// `coordinator.selectTeam`, which switches the active team (fresh session for
/// that org) and lands the app. See
/// docs/specs/2026-06-17-teamclaw-phone-login-and-tenancy.md §6.
struct OrgTeamPickerView: View {
    @Bindable var coordinator: AppOnboardingCoordinator
    @State private var busyTeamID: String?

    /// Teams grouped by org name, preserving first-seen order. Teams without an
    /// org name fall into a single "Other" bucket.
    private var groups: [(org: String, teams: [MembershipTeam])] {
        var order: [String] = []
        var byOrg: [String: [MembershipTeam]] = [:]
        for team in coordinator.teamChoices {
            let key = team.orgName ?? "Other"
            if byOrg[key] == nil { order.append(key) }
            byOrg[key, default: []].append(team)
        }
        return order.map { ($0, byOrg[$0] ?? []) }
    }

    var body: some View {
        NavigationStack {
            List {
                if let err = coordinator.errorMessage {
                    Section {
                        Text(err).font(.footnote).foregroundStyle(.red)
                    }
                }
                ForEach(groups, id: \.org) { group in
                    Section(group.org) {
                        ForEach(group.teams) { team in
                            Button {
                                pick(team.id)
                            } label: {
                                HStack {
                                    Text(team.name)
                                    Spacer()
                                    if busyTeamID == team.id {
                                        ProgressView()
                                    } else {
                                        Image(systemName: "chevron.right")
                                            .font(.footnote)
                                            .foregroundStyle(.tertiary)
                                    }
                                }
                            }
                            .disabled(busyTeamID != nil)
                        }
                    }
                }
            }
            .navigationTitle("Choose a team")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func pick(_ teamID: String) {
        guard busyTeamID == nil else { return }
        busyTeamID = teamID
        Task {
            await coordinator.selectTeam(teamID: teamID)
            busyTeamID = nil
        }
    }
}

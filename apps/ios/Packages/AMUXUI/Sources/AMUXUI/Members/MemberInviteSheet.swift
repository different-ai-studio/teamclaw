import SwiftUI
import AMUXSharedUI
import SwiftData
import AMUXCore

#if os(iOS)

public struct MemberInviteSheet: View {
    @Environment(\.dismiss) private var dismiss
    let store: ActorStore

    @State private var kind: InviteKind = .member
    @State private var name = ""
    @State private var teamRole: TeamRole = .member
    @State private var agentKind: String = "daemon"
    @State private var isInviting = false
    @State private var errorMessage: String?
    @State private var invite: InviteCreated?
    // Shown when a member invite is blocked because the team is still in the
    // shared default org (FC 403 upgrade_required) — prompts an org upgrade.
    @State private var needsUpgrade = false
    @State private var orgName = ""
    @State private var contact = ""
    @State private var isUpgrading = false

    public init(store: ActorStore) { self.store = store }

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private var canInvite: Bool {
        !trimmedName.isEmpty && !isInviting && invite == nil
    }

    public var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Kind", selection: $kind) {
                        Text("Teammate").tag(InviteKind.member)
                        Text("Agent").tag(InviteKind.agent)
                    }
                    .pickerStyle(.segmented)
                    .disabled(invite != nil)
                    .accessibilityIdentifier("invite.kindPicker")

                    TextField("Name", text: $name)
                        .disabled(invite != nil)
                        .accessibilityIdentifier("invite.nameField")

                    if kind == .member {
                        Picker("Role", selection: $teamRole) {
                            Text("Member").tag(TeamRole.member)
                            Text("Admin").tag(TeamRole.admin)
                        }.disabled(invite != nil)
                    } else {
                        Picker("Agent kind", selection: $agentKind) {
                            Text("Daemon").tag("daemon")
                        }.disabled(invite != nil)
                    }
                } footer: {
                    if let errorMessage, !needsUpgrade {
                        Text(errorMessage).foregroundStyle(Color.amux.cinnabarDeep)
                    }
                }

                if needsUpgrade {
                    Section {
                        Text("当前团队还在公共组织下，只能自己使用。升级账号、创建你自己的团队后即可邀请成员。")
                            .font(.footnote).foregroundStyle(.secondary)
                        TextField("团队/组织名称", text: $orgName)
                            .accessibilityIdentifier("invite.upgradeOrgName")
                        TextField("联系方式（选填）", text: $contact)
                        Button {
                            upgrade()
                        } label: {
                            if isUpgrading { ProgressView() } else { Text("升级账号") }
                        }
                        .disabled(orgName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isUpgrading)
                        .accessibilityIdentifier("invite.upgradeButton")
                    } header: {
                        Text("升级账号")
                    } footer: {
                        if let errorMessage {
                            Text(errorMessage).foregroundStyle(Color.amux.cinnabarDeep)
                        }
                    }
                }

                if let invite {
                    Section("Share invite") {
                        Text(invite.deeplink).font(.footnote)
                            .textSelection(.enabled).foregroundStyle(.secondary)
                            .accessibilityIdentifier("invite.deeplinkText")
                        ShareLink(item: invite.deeplink) {
                            Label("Share link", systemImage: "square.and.arrow.up")
                        }
                        .accessibilityIdentifier("invite.shareLinkButton")
                        Button {
                            UIPasteboard.general.string = invite.deeplink
                        } label: {
                            Label("Copy link", systemImage: "doc.on.doc")
                        }
                        .accessibilityIdentifier("invite.copyLinkButton")
                        LabeledContent("Expires",
                                       value: invite.expiresAt.formatted(date: .abbreviated, time: .shortened))
                            .font(.caption)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.amux.mist)
            .navigationTitle("Invite")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button { reset(); dismiss() } label: {
                        Image(systemName: "xmark").font(.title3).foregroundStyle(.secondary)
                    }.buttonStyle(.plain)
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    if invite != nil {
                        Button { reset(); dismiss() } label: { Text("Done") }
                            .accessibilityIdentifier("invite.doneButton")
                    } else {
                        Button { run() } label: {
                            HStack(spacing: 6) {
                                if isInviting { ProgressView().controlSize(.small) }
                                Text("Invite")
                            }
                        }
                        .disabled(!canInvite)
                        .opacity(canInvite ? 1 : 0.4)
                        .accessibilityIdentifier("invite.submitButton")
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func run() {
        errorMessage = nil
        guard canInvite else { return }
        isInviting = true
        Task {
            let input = InviteCreateInput(
                kind: kind, displayName: trimmedName,
                teamRole: kind == .member ? teamRole : nil,
                agentKind: kind == .agent ? agentKind : nil
            )
            if let created = await store.createInvite(input) {
                invite = created
            } else if store.lastErrorCode == "upgrade_required" {
                needsUpgrade = true
                errorMessage = nil
            } else {
                errorMessage = store.errorMessage ?? "Failed to create invite."
            }
            isInviting = false
        }
    }

    private func upgrade() {
        let trimmedOrg = orgName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedOrg.isEmpty, !isUpgrading else { return }
        errorMessage = nil
        isUpgrading = true
        Task {
            let trimmedContact = contact.trimmingCharacters(in: .whitespacesAndNewlines)
            if await store.upgradeAccount(orgName: trimmedOrg, contact: trimmedContact.isEmpty ? nil : trimmedContact) != nil {
                // Team left the default org — clear the prompt so the user can
                // invite. (Session/team refresh is handled by the app's stores.)
                needsUpgrade = false
                orgName = ""; contact = ""
            } else {
                errorMessage = store.errorMessage ?? "升级失败，请重试。"
            }
            isUpgrading = false
        }
    }

    private func reset() {
        kind = .member; name = ""; teamRole = .member; agentKind = "daemon"
        isInviting = false; errorMessage = nil; invite = nil
        needsUpgrade = false; orgName = ""; contact = ""; isUpgrading = false
    }
}
#else
public struct MemberInviteSheet: View {
    public init(store: ActorStore) {}
    public var body: some View { Text("Invites are iOS-only.").padding(24) }
}
#endif

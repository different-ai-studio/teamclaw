import SwiftUI
import SwiftData

struct FunctionPanelView: View {
    let mqttService: MQTTServiceProtocol
    @ObservedObject var pairingManager: PairingManager
    @ObservedObject var connectionMonitor: ConnectionMonitor

    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext

    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink {
                        TaskListView(
                            viewModel: TaskViewModel(
                                modelContext: modelContext,
                                mqttService: mqttService
                            )
                        )
                    } label: {
                        Label("自动化", systemImage: "bolt.fill")
                            .foregroundStyle(.orange)
                    }

                    NavigationLink {
                        SkillHomeView(
                            viewModel: SkillViewModel(
                                modelContext: modelContext,
                                mqttService: mqttService
                            )
                        )
                    } label: {
                        Label("技能", systemImage: "puzzlepiece.fill")
                            .foregroundStyle(.purple)
                    }

                    NavigationLink {
                        FeaturedAllyListView(
                            viewModel: TalentViewModel(
                                modelContext: modelContext,
                                mqttService: mqttService
                            )
                        )
                    } label: {
                        Label("精选搭档", systemImage: "cpu.fill")
                            .foregroundStyle(.blue)
                    }

                    NavigationLink {
                        SkillMarketListView(
                            viewModel: SkillViewModel(
                                modelContext: modelContext,
                                mqttService: mqttService
                            )
                        )
                    } label: {
                        Label("技能市场", systemImage: "bag.fill")
                            .foregroundStyle(.teal)
                    }
                }

                Section {
                    NavigationLink {
                        SettingsView(
                            pairingManager: pairingManager,
                            connectionMonitor: connectionMonitor
                        )
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "person.circle.fill")
                                .font(.title2)
                                .foregroundStyle(.secondary)
                            Text("个人设置")
                        }
                    }
                }
            }
            .navigationTitle("功能")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") {
                        dismiss()
                    }
                }
            }
        }
    }
}

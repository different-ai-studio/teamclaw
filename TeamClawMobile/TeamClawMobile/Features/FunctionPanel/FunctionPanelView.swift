import SwiftUI
import SwiftData

struct FunctionPanelView: View {
    let mqttService: MQTTServiceProtocol
    @ObservedObject var pairingManager: PairingManager
    @ObservedObject var connectionMonitor: ConnectionMonitor

    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext

    @StateObject private var taskViewModel: TaskViewModel
    @StateObject private var skillViewModel: SkillViewModel
    @StateObject private var talentViewModel: TalentViewModel

    init(mqttService: MQTTServiceProtocol, pairingManager: PairingManager, connectionMonitor: ConnectionMonitor) {
        self.mqttService = mqttService
        self.pairingManager = pairingManager
        self.connectionMonitor = connectionMonitor
        _taskViewModel = StateObject(wrappedValue: TaskViewModel(mqttService: mqttService))
        _skillViewModel = StateObject(wrappedValue: SkillViewModel(mqttService: mqttService))
        _talentViewModel = StateObject(wrappedValue: TalentViewModel(mqttService: mqttService))
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink {
                        TaskListView(viewModel: taskViewModel)
                    } label: {
                        Label("自动化", systemImage: "bolt.fill")
                            .foregroundStyle(.orange)
                    }

                    NavigationLink {
                        SkillHomeView(viewModel: skillViewModel)
                    } label: {
                        Label("技能", systemImage: "puzzlepiece.fill")
                            .foregroundStyle(.purple)
                    }

                    NavigationLink {
                        FeaturedAllyListView(viewModel: talentViewModel)
                    } label: {
                        Label("精选搭档", systemImage: "cpu.fill")
                            .foregroundStyle(.blue)
                    }

                    NavigationLink {
                        SkillMarketListView(viewModel: skillViewModel)
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
            .onAppear {
                taskViewModel.setModelContext(modelContext)
                skillViewModel.setModelContext(modelContext)
                talentViewModel.setModelContext(modelContext)
            }
        }
    }
}

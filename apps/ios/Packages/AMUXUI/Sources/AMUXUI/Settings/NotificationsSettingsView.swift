import SwiftUI
import AMUXCore

@MainActor
public struct NotificationsSettingsView: View {
    let store: NotificationPrefsStore

    public init(store: NotificationPrefsStore) {
        self.store = store
    }

    public var body: some View {
        Form {
            Section {
                Toggle("Enable push notifications", isOn: Binding(
                    get: { store.prefs.enabled },
                    set: { on in Task { await store.setEnabled(on) } }
                ))
            }

            Section("Do Not Disturb") {
                Toggle("Enabled", isOn: Binding(
                    get: { store.prefs.dndStartMin != nil },
                    set: { on in
                        Task {
                            if on {
                                await store.setQuietHours(
                                    startMin: store.prefs.dndStartMin ?? 22 * 60,
                                    endMin: store.prefs.dndEndMin ?? 7 * 60
                                )
                            } else {
                                await store.setQuietHours(startMin: nil, endMin: nil)
                            }
                        }
                    }
                ))

                if store.prefs.dndStartMin != nil {
                    DatePicker("Start", selection: bindMinute(
                        get: { store.prefs.dndStartMin },
                        set: { newStart in
                            Task {
                                await store.setQuietHours(
                                    startMin: newStart,
                                    endMin: store.prefs.dndEndMin
                                )
                            }
                        }
                    ), displayedComponents: .hourAndMinute)

                    DatePicker("End", selection: bindMinute(
                        get: { store.prefs.dndEndMin },
                        set: { newEnd in
                            Task {
                                await store.setQuietHours(
                                    startMin: store.prefs.dndStartMin,
                                    endMin: newEnd
                                )
                            }
                        }
                    ), displayedComponents: .hourAndMinute)
                }
            }

            if let error = store.errorMessage {
                Section {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(Color.amux.cinnabarDeep)
                }
            }
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.large)
        .task {
            await store.reload()
        }
    }

    /// Bridge a minute-of-day Int? to the hour+minute DatePicker.
    private func bindMinute(
        get: @escaping () -> Int?,
        set: @escaping (Int) -> Void
    ) -> Binding<Date> {
        Binding(
            get: {
                let m = get() ?? 0
                return Calendar.current.date(
                    bySettingHour: m / 60, minute: m % 60, second: 0, of: Date()
                ) ?? Date()
            },
            set: { newDate in
                let comps = Calendar.current.dateComponents([.hour, .minute], from: newDate)
                set((comps.hour ?? 0) * 60 + (comps.minute ?? 0))
            }
        )
    }
}

import SwiftUI
import AMUXCore
import AMUXSharedUI

/// Pre-auth server picker: lets self-host users point the app at their own
/// Cloud API before signing in. Saving validates the address by probing
/// `GET /v1/config/public`, persists the override, then hands control back
/// to ContentView, which rebuilds the Cloud API stack against the new base
/// URL — no relaunch required.
struct ServerSettingsSheet: View {
    var onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var urlText: String = CloudAPIConfigurationStore.storedCloudAPIURL() ?? ""
    @State private var isProbing = false
    @State private var errorMessage: String?

    private var bundledDefault: String? { CloudAPIConfigurationStore.bundledCloudAPIURL }
    private var isOverridden: Bool { CloudAPIConfigurationStore.hasCloudAPIURLOverride() }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://api.example.com", text: $urlText)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(.body, design: .monospaced))
                        .accessibilityIdentifier("serverSettings.urlField")
                } header: {
                    Text("Server address")
                } footer: {
                    Text("The TeamClu Cloud API this app talks to. Everything else — including the message broker — is discovered from it.")
                }

                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(Color.amux.cinnabar)
                    }
                }

                if isOverridden, let bundledDefault {
                    Section {
                        Button("Use default server") {
                            urlText = bundledDefault
                            errorMessage = nil
                        }
                        .accessibilityIdentifier("serverSettings.useDefaultButton")
                    } footer: {
                        Text("Default: \(bundledDefault)")
                    }
                }
            }
            .navigationTitle("Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isProbing)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isProbing {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }
                            .accessibilityIdentifier("serverSettings.saveButton")
                    }
                }
            }
            .interactiveDismissDisabled(isProbing)
        }
    }

    private func save() async {
        errorMessage = nil
        guard let url = ServerEndpoint.normalize(urlText) else {
            errorMessage = String(localized: "Enter a server address like https://api.example.com.")
            return
        }
        isProbing = true
        switch await ServerEndpoint.probe(url) {
        case .reachable:
            break
        case .badStatus(let code):
            isProbing = false
            errorMessage = String(localized: "That server answered with HTTP \(code) — it doesn't look like a TeamClu Cloud API.")
            return
        case .unreachable(let reason):
            isProbing = false
            errorMessage = String(localized: "Can't reach that server: \(reason)")
            return
        }
        isProbing = false
        // Saving the bundled default back is the same as clearing the override.
        if url.absoluteString == bundledDefault {
            CloudAPIConfigurationStore.setCloudAPIURLOverride(nil)
        } else {
            CloudAPIConfigurationStore.setCloudAPIURLOverride(url)
        }
        dismiss()
        onSaved()
    }
}

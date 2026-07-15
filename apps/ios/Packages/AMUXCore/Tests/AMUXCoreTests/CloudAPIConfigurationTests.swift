import Foundation
import Testing
@testable import AMUXCore

@Suite("Cloud API configuration")
struct CloudAPIConfigurationTests {
    @Test
    func defaultsToCloudAPIWhenBundleProvidesCloudURL() {
        // No stored preference. The bundled services.default.json now ships a
        // cloudApiUrl, so the production default is the Cloud API and a usable
        // configuration is resolved from bundled values.
        let defaults = UserDefaults(suiteName: "CloudAPIConfigurationTests.defaults")!
        defaults.removePersistentDomain(forName: "CloudAPIConfigurationTests.defaults")

        #expect(CloudAPIConfigurationStore.backendKind(in: defaults) == .cloudAPI)
        let config = CloudAPIConfigurationStore.configuration(in: defaults)
        #expect(config != nil)
        #expect(config?.baseURL.absoluteString == "https://teamclaw-api.ucar.cc")
    }

    @Test
    func explicitSupabasePreferenceWins() {
        let suite = "CloudAPIConfigurationTests.explicitSupabase"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        defaults.set("supabase", forKey: CloudAPIConfigurationStore.backendKindKey)

        #expect(CloudAPIConfigurationStore.backendKind(in: defaults) == .supabase)
        #expect(CloudAPIConfigurationStore.configuration(in: defaults) == nil)
    }

    @Test
    func buildsCloudAPIConfigurationWhenStored() throws {
        let suite = "CloudAPIConfigurationTests.cloud"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        defaults.set("cloud_api", forKey: CloudAPIConfigurationStore.backendKindKey)
        defaults.set("https://fc.example.com", forKey: CloudAPIConfigurationStore.cloudAPIURLKey)

        let config = try #require(CloudAPIConfigurationStore.configuration(in: defaults))
        #expect(config.baseURL.absoluteString == "https://fc.example.com")
    }
}

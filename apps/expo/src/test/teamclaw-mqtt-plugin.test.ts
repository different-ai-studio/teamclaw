import { describe, expect, it } from "vitest";

const plugin = require("../../plugins/withTeamClawMqtt");

describe("withTeamClawMqtt config plugin helpers", () => {
  it("adds the HiveMQ dependency once", () => {
    const gradle = 'dependencies {\n    implementation("com.facebook.react:react-android")\n}';

    const once = plugin.addMqttDependency(gradle);
    const twice = plugin.addMqttDependency(once);

    expect(once).toContain('implementation("com.hivemq:hivemq-mqtt-client:1.3.3")');
    expect(twice.match(/com\.hivemq:hivemq-mqtt-client/g)).toHaveLength(1);
  });

  it("excludes duplicate Netty Java resources once", () => {
    const gradle = [
      "android {",
      "    packagingOptions {",
      "        jniLibs {",
      "            useLegacyPackaging false",
      "        }",
      "    }",
      "}",
    ].join("\n");

    const once = plugin.addMqttPackagingExcludes(gradle);
    const twice = plugin.addMqttPackagingExcludes(once);

    expect(once).toContain("excludes += 'META-INF/INDEX.LIST'");
    expect(once).toContain("excludes += 'META-INF/io.netty.versions.properties'");
    expect(twice.match(/META-INF\/INDEX\.LIST/g)).toHaveLength(1);
    expect(twice.match(/META-INF\/io\.netty\.versions\.properties/g)).toHaveLength(1);
  });

  it("registers the React package once", () => {
    const mainApplication = [
      "          override fun getPackages(): List<ReactPackage> {",
      "            val packages = PackageList(this).packages",
      "            // Packages that cannot be autolinked yet can be added manually here, for example:",
      "            // packages.add(MyReactNativePackage())",
      "            return packages",
      "          }",
    ].join("\n");

    const once = plugin.addPackageRegistration(mainApplication);
    const twice = plugin.addPackageRegistration(once);

    expect(once).toContain("packages.add(TeamClawMqttPackage())");
    expect(twice.match(/TeamClawMqttPackage/g)).toHaveLength(1);
  });

  it("adds the CocoaMQTT pod once", () => {
    const podfile = [
      "platform :ios, '15.1'",
      "",
      "target 'TeamClawExpo' do",
      "  use_expo_modules!",
      "end",
    ].join("\n");

    const once = plugin.addCocoaMqttPod(podfile);
    const twice = plugin.addCocoaMqttPod(once);

    expect(once).toContain("pod 'CocoaMQTT', '~> 2.2.3'");
    expect(twice.match(/pod 'CocoaMQTT'/g)).toHaveLength(1);
  });
});

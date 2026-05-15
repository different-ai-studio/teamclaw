plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "tech.teamclaw.android.core.deeplink"
    compileSdk = 35
    defaultConfig { minSdk = 26 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    testOptions { unitTests.isIncludeAndroidResources = true }
}

dependencies {
    testImplementation(libs.junit4)
    testImplementation(libs.truth)
    testImplementation("org.robolectric:robolectric:4.14")
    testImplementation(libs.androidx.test.ext.junit)
}
// Robolectric requires JUnit4; don't switch to Jupiter for this module.

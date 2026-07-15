// swift-tools-version: 6.2
//
// AMUXUI — feature screens.
//
// Allowed: SwiftUI screens, sheets, navigation containers, and the
// view-models/glue specific to those screens. May depend on AMUXCore
// (domain) and AMUXSharedUI (reusable rendering).
//
// Nothing depends on AMUXUI; it sits at the leaf. App composition
// (AMUXApp) injects dependencies into the screens here.
//
import PackageDescription

let package = Package(
    name: "AMUXUI",
    platforms: [.iOS(.v26)],
    products: [
        .library(name: "AMUXUI", targets: ["AMUXUI"]),
    ],
    dependencies: [
        .package(path: "../AMUXCore"),
        .package(path: "../AMUXSharedUI"),
    ],
    targets: [
        .target(
            name: "AMUXUI",
            dependencies: [
                "AMUXCore",
                "AMUXSharedUI",
            ],
            resources: [.process("Resources")]
        ),
        .testTarget(
            name: "AMUXUIPackageTests",
            dependencies: ["AMUXUI"]
        ),
    ]
)

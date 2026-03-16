// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "YaaiaVM",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/httpswift/swifter.git", .upToNextMajor(from: "1.5.0")),
    ],
    targets: [
        .executableTarget(
            name: "YaaiaVM",
            dependencies: [.product(name: "Swifter", package: "swifter")],
            path: "Sources/YaaiaVM",
            resources: [.copy("Resources")],
            swiftSettings: [
                .unsafeFlags(["-parse-as-library"]),
            ],
            linkerSettings: [
                .linkedFramework("Virtualization"),
                .linkedFramework("AppKit"),
                .linkedFramework("Foundation"),
                .linkedFramework("Network"),
                .linkedFramework("IOSurface"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("CoreGraphics"),
            ]
        ),
    ]
)

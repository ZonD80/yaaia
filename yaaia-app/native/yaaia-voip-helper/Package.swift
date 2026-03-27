// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "yaaia-voip-helper",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "yaaia-voip-helper", targets: ["yaaia-voip-helper"]),
    ],
    targets: [
        .executableTarget(
            name: "yaaia-voip-helper",
            path: "Sources"
        ),
    ]
)

// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "APW",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .executable(name: "APW", targets: ["APW"]),
    ],
    targets: [
        .executableTarget(
            name: "APW",
            path: "Sources"
        ),
    ]
)

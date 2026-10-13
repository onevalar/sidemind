// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "SidemindApp",
    platforms: [
        .macOS(.v14)
    ],
    dependencies: [
        .package(url: "https://github.com/swiftlang/swift-markdown.git", branch: "main"),
    ],
    targets: [
        .executableTarget(
            name: "SidemindApp",
            dependencies: [
                .product(name: "Markdown", package: "swift-markdown")
            ],
            path: "Sources",
            exclude: ["Tests"]
        ),
        .testTarget(
            name: "SidemindAppTests",
            dependencies: ["SidemindApp"],
            path: "Sources/Tests"
        )
    ]
)

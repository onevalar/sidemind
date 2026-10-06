// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "CanvasNoteApp",
    platforms: [
        .macOS(.v14)
    ],
    dependencies: [
        .package(url: "https://github.com/swiftlang/swift-markdown.git", branch: "main"),
    ],
    targets: [
        .executableTarget(
            name: "CanvasNoteApp",
            dependencies: [
                .product(name: "Markdown", package: "swift-markdown")
            ],
            path: "Sources",
            exclude: ["Tests"]
        ),
        .testTarget(
            name: "CanvasNoteAppTests",
            dependencies: ["CanvasNoteApp"],
            path: "Sources/Tests"
        )
    ]
)

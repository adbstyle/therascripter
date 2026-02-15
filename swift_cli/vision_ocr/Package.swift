// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "vision-ocr",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "vision-ocr",
            path: "Sources"
        )
    ]
)

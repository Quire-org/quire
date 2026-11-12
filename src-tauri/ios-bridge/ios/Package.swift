// swift-tools-version:5.3

import PackageDescription

let package = Package(
  name: "quire-ios-bridge",
  platforms: [
    .iOS(.v14)
  ],
  products: [
    .library(name: "quire-ios-bridge", type: .static, targets: ["quire-ios-bridge"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(name: "quire-ios-bridge", dependencies: [.byName(name: "Tauri")], path: "Sources")
  ]
)

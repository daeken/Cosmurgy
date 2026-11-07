import AppKit
import Foundation
import Darwin

struct LaunchFailure: Error, CustomStringConvertible { let description: String }
let manager = FileManager.default
let environment = ProcessInfo.processInfo.environment
let arguments = Array(CommandLine.arguments.dropFirst())
let diagnosing = arguments.contains("--diagnose")
let resources = Bundle.main.resourceURL!
let configDirectory = environment["COSMURGY_CONFIG_DIR"] ?? NSHomeDirectory() + "/.config/cosmurgy"
let configURL = URL(fileURLWithPath: configDirectory).appendingPathComponent("launcher.json")
func load(_ url: URL) throws -> [String: String] {
    guard manager.fileExists(atPath: url.path) else { return [:] }
    return try JSONDecoder().decode([String: String].self, from: Data(contentsOf: url))
}
func save(_ config: [String: String]) throws {
    try manager.createDirectory(at: configURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try JSONEncoder().encode(config).write(to: configURL, options: .atomic)
    try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configURL.path)
}
func validCheckout(_ path: String) -> Bool { manager.fileExists(atPath: path + "/src/app.ts") && manager.fileExists(atPath: path + "/package.json") }
func expanded(_ path: String) -> String { URL(fileURLWithPath: (path as NSString).expandingTildeInPath).standardizedFileURL.path }
func emit(_ value: [String: String]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
}
do {
    var config = try load(configURL)
    var configChanged = false
    let defaults = try load(resources.appendingPathComponent("Checkout.json"))
    var index = 0
    while index < arguments.count {
        switch arguments[index] {
        case "--diagnose": break
        case "--checkout", "--jonui":
            let option = arguments[index]; index += 1
            guard index < arguments.count else { throw LaunchFailure(description: option + " needs a path.") }
            config[option == "--checkout" ? "checkout" : "jonui"] = expanded(arguments[index])
            configChanged = true
        default: throw LaunchFailure(description: "Unknown launcher argument: " + arguments[index])
        }
        index += 1
    }
    var checkout = expanded(environment["COSMURGY_ROOT"] ?? config["checkout"] ?? defaults["checkout"] ?? "")
    if !validCheckout(checkout) {
        if diagnosing || environment["COSMURGY_ROOT"] != nil { throw LaunchFailure(description: "Cannot find a Cosmurgy checkout at " + checkout) }
        NSApplication.shared.setActivationPolicy(.accessory)
        let panel = NSOpenPanel()
        panel.title = "Locate your Cosmurgy checkout"
        panel.message = "Choose the repository containing src/app.ts. Cosmurgy runs the live source in this folder."
        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let chosen = panel.url else { exit(0) }
        checkout = chosen.standardizedFileURL.path
        guard validCheckout(checkout) else { throw LaunchFailure(description: "That folder is not a Cosmurgy checkout.") }
        config["checkout"] = checkout; configChanged = true
    }
    for dependency in ["esbuild", "jose"] {
        guard manager.fileExists(atPath: checkout + "/node_modules/" + dependency + "/package.json") else {
            throw LaunchFailure(description: "Checkout dependencies are missing. Run ./bin/dev install in " + checkout)
        }
    }
    let bundledRuntime = resources.appendingPathComponent("JonUI").path
    let requestedRuntime = environment["JONUI_ROOT"] ?? config["jonui"]
    let developmentRuntime = defaults["jonui"].map(expanded)
    let runtime: String
    if let requested = requestedRuntime {
        runtime = expanded(requested)
    } else if let development = developmentRuntime, manager.fileExists(atPath: development + "/runtime/bootstrap.mjs") {
        runtime = development
    } else { runtime = bundledRuntime }
    guard manager.fileExists(atPath: runtime + "/runtime/bootstrap.mjs"), manager.fileExists(atPath: runtime + "/runtime/index.mjs") else {
        throw LaunchFailure(description: "Cannot find the JonUI JavaScript runtime at " + runtime)
    }
    let host = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/jonui").path
    guard manager.isExecutableFile(atPath: host) else { throw LaunchFailure(description: "The bundled native host is missing. Rebuild Cosmurgy.app.") }
    if configChanged { try save(config) }
    if diagnosing {
        try emit(["checkout": checkout, "entry": checkout + "/src/app.ts", "runtime": runtime, "nativeHost": host,
                  "bundleIdentifier": Bundle.main.bundleIdentifier ?? "", "icon": resources.appendingPathComponent("Cosmurgy.icns").path,
                  "configuration": configURL.path, "bundledRuntime": runtime == bundledRuntime ? "true" : "false"])
        exit(0)
    }
    // Finder doesn't provide a useful terminal. Keep diagnostics locally, outside the checkout.
    if environment["JONUI_TEST"] != "1" {
        let logs = URL(fileURLWithPath: NSHomeDirectory() + "/Library/Logs/Cosmurgy")
        try manager.createDirectory(at: logs, withIntermediateDirectories: true)
        let descriptor = open(logs.appendingPathComponent("Cosmurgy.log").path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
        if descriptor >= 0 { dup2(descriptor, STDOUT_FILENO); dup2(descriptor, STDERR_FILENO); close(descriptor) }
    }
    setenv("COSMURGY_ROOT", checkout, 1); setenv("JONUI_ROOT", runtime, 1)
    guard chdir(checkout) == 0 else { throw LaunchFailure(description: "Could not enter the checkout directory.") }
    let command = [host, checkout + "/src/app.ts"]
    let pointers = command.map { strdup($0) } + [nil]
    pointers.withUnsafeBufferPointer { buffer in _ = execv(host, buffer.baseAddress!) }
    for pointer in pointers { free(pointer) }
    throw LaunchFailure(description: "Could not start the native host: " + String(cString: strerror(errno)))
} catch {
    let message = String(describing: error)
    if diagnosing { try? emit(["error": message]); exit(2) }
    fputs("Cosmurgy: " + message + "\n", stderr)
    NSApplication.shared.setActivationPolicy(.accessory)
    let alert = NSAlert(); alert.messageText = "Cosmurgy could not start"; alert.informativeText = message
    alert.addButton(withTitle: "OK"); alert.runModal(); exit(1)
}

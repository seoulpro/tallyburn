import Darwin
import Foundation

struct SidecarConfiguration: Equatable {
  var cliPath: String
  var windows: String
  var mode: MonitoringMode
  var codexAccount: Bool
  var otelMetrics: Bool
  var llamaCppMetricsURL: String
  var vllmMetricsURL: String

  init(
    cliPath: String,
    windows: String,
    mode: MonitoringMode,
    codexAccount: Bool,
    otelMetrics: Bool = false,
    llamaCppMetricsURL: String = "",
    vllmMetricsURL: String = ""
  ) {
    self.cliPath = cliPath
    self.windows = windows
    self.mode = mode
    self.codexAccount = codexAccount
    self.otelMetrics = otelMetrics
    self.llamaCppMetricsURL = llamaCppMetricsURL
    self.vllmMetricsURL = vllmMetricsURL
  }
}

enum MonitoringMode: String, CaseIterable, Identifiable {
  case standard
  case metricsOnly
  case demo

  var id: String { rawValue }

  var title: String {
    switch self {
    case .standard:
      return localized(
        "monitoring.mode.standard",
        fallback: "Standard local monitoring"
      )
    case .metricsOnly:
      return localized(
        "monitoring.mode.metricsOnly",
        fallback: "Local metrics only"
      )
    case .demo:
      return localized(
        "monitoring.mode.demo",
        fallback: "Demo preview"
      )
    }
  }

  var privacyDescription: String {
    switch self {
    case .standard:
      return localized(
        "monitoring.mode.standard.description",
        fallback:
          "Reads supported local session logs and official client status; retains only numeric usage and plan labels."
      )
    case .metricsOnly:
      return localized(
        "monitoring.mode.metricsOnly.description",
        fallback:
          "Reads no transcripts; receives supported CLI telemetry and local model-server counters on this Mac."
      )
    case .demo:
      return localized(
        "monitoring.mode.demo.description",
        fallback: "Uses synthetic values and touches no provider data."
      )
    }
  }
}

enum SidecarState: Equatable {
  case idle
  case starting
  case connected
  case paused
  case failed(String)
}

protocol SidecarControlling: AnyObject {
  func start(
    configuration: SidecarConfiguration,
    onEnvelope: @escaping (SnapshotEnvelope) -> Void,
    onState: @escaping (SidecarState) -> Void
  )

  func stop(completion: (() -> Void)?)
}

extension SidecarControlling {
  func stop() {
    stop(completion: nil)
  }
}

struct SidecarTiming {
  var startupTimeout: TimeInterval
  var heartbeatTimeout: TimeInterval
  var stopGracePeriod: TimeInterval

  static let production = SidecarTiming(
    startupTimeout: 15,
    heartbeatTimeout: 6,
    stopGracePeriod: 1.5
  )
}

enum RollingWindowConfiguration {
  static func normalize(_ input: String) -> String? {
    let labels =
      input
      .split(separator: ",", omittingEmptySubsequences: false)
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
    guard (1...6).contains(labels.count),
      labels.allSatisfy({ !$0.isEmpty })
    else {
      return nil
    }

    var durations = Set<Int64>()
    for label in labels {
      guard let duration = durationMilliseconds(label),
        duration <= 30 * 86_400_000,
        durations.insert(duration).inserted
      else {
        return nil
      }
    }
    return labels.joined(separator: ",")
  }

  private static func durationMilliseconds(_ label: String) -> Int64? {
    let units: [(String, Double)] = [
      ("ms", 1),
      ("s", 1_000),
      ("m", 60_000),
      ("h", 3_600_000),
      ("d", 86_400_000),
    ]
    guard
      let (suffix, multiplier) = units.first(where: {
        label.hasSuffix($0.0)
      })
    else {
      return nil
    }
    let number = String(label.dropLast(suffix.count))
    guard !number.isEmpty,
      number.filter({ $0 == "." }).count <= 1,
      number.allSatisfy({ $0.isNumber || $0 == "." }),
      let amount = Double(number),
      amount.isFinite
    else {
      return nil
    }
    let milliseconds = (amount * multiplier).rounded()
    guard milliseconds >= 1, milliseconds <= Double(Int64.max) else {
      return nil
    }
    return Int64(milliseconds)
  }
}

enum SidecarLaunchPolicy {
  static func isDistinctExecutable(
    _ candidate: URL,
    from appExecutable: URL?
  ) -> Bool {
    guard FileManager.default.isExecutableFile(atPath: candidate.path) else {
      return false
    }
    guard let appExecutable else { return true }

    let candidatePath = candidate.resolvingSymlinksInPath().path
    let appPath = appExecutable.resolvingSymlinksInPath().path
    guard
      let candidateAttributes = try? FileManager.default
        .attributesOfItem(atPath: candidatePath),
      let appAttributes = try? FileManager.default
        .attributesOfItem(atPath: appPath),
      let candidateDevice =
        candidateAttributes[.systemNumber] as? NSNumber,
      let candidateFile =
        candidateAttributes[.systemFileNumber] as? NSNumber,
      let appDevice = appAttributes[.systemNumber] as? NSNumber,
      let appFile = appAttributes[.systemFileNumber] as? NSNumber
    else {
      return false
    }
    return candidateDevice != appDevice || candidateFile != appFile
  }

  static func firstDistinctExecutable(
    preferred: String?,
    candidates: [String],
    from appExecutable: URL?
  ) -> URL? {
    for candidate in [preferred].compactMap({ $0 }) + candidates {
      let expanded = NSString(string: candidate).expandingTildeInPath
      let url = URL(fileURLWithPath: expanded)
      if isDistinctExecutable(url, from: appExecutable) {
        return url
      }
    }
    return nil
  }

  static func arguments(
    for configuration: SidecarConfiguration,
    isolatedConfigURL: URL,
    codexExecutable: URL?,
    claudeExecutable: URL?
  ) -> [String] {
    var arguments = [
      "stream",
      "--config", isolatedConfigURL.path,
      "--windows", configuration.windows,
      "--refresh", "1s",
      "--no-color",
    ]

    var providers: [String]
    switch configuration.mode {
    case .standard:
      providers = ["codex", "claude"]
      if configuration.otelMetrics {
        providers += ["gemini", "copilot", "qwen"]
        arguments += ["--otel-port", "4318"]
      }
    case .metricsOnly:
      providers = ["claude", "gemini", "copilot", "qwen"]
      arguments += ["--no-backfill", "--otel-port", "4318"]
    case .demo:
      providers = [
        "codex", "claude", "gemini", "copilot", "qwen", "llamacpp", "vllm",
      ]
      arguments += ["--demo", "--no-backfill"]
    }

    if configuration.mode != .demo {
      if !configuration.llamaCppMetricsURL.isEmpty {
        providers.append("llamacpp")
        arguments += [
          "--llamacpp-metrics", configuration.llamaCppMetricsURL,
        ]
      }
      if !configuration.vllmMetricsURL.isEmpty {
        providers.append("vllm")
        arguments += ["--vllm-metrics", configuration.vllmMetricsURL]
      }
    }
    arguments += ["--providers", providers.joined(separator: ",")]

    let allowsCodexAccount =
      configuration.codexAccount && configuration.mode == .standard
    if allowsCodexAccount {
      arguments.append("--codex-account")
      if let codexExecutable {
        arguments += ["--codex-executable", codexExecutable.path]
      }
    } else {
      arguments.append("--no-codex-account")
    }

    if configuration.mode == .standard {
      // Claude Code's official auth-status command starts no model request and
      // lets the dashboard distinguish a detected plan from an unavailable
      // usage percentage before Claude has been opened.
      arguments.append("--claude-account")
      if let claudeExecutable {
        arguments += ["--claude-executable", claudeExecutable.path]
      }
    } else {
      arguments += ["--no-claude-account", "--offline"]
    }
    return arguments
  }

  static func sanitizedEnvironment(
    from source: [String: String]
  ) -> [String: String] {
    var environment = source.filter { key, _ in
      !key.hasPrefix("TALLYBURN_")
        && !key.hasPrefix("OTEL_")
        && key != "ANTHROPIC_API_KEY"
        && key != "ANTHROPIC_AUTH_TOKEN"
        && key != "CLAUDE_CODE_OAUTH_TOKEN"
        && key != "NODE_OPTIONS"
        && key != "NODE_PATH"
    }
    let existing = environment["PATH"] ?? ""
    let paths =
      [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
      ] + existing.split(separator: ":").map(String.init)
    environment["PATH"] = Array(NSOrderedSet(array: paths))
      .compactMap { $0 as? String }
      .filter { !$0.isEmpty }
      .joined(separator: ":")
    return environment
  }
}

func normalizedLocalMetricsURL(_ input: String) -> String? {
  let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return "" }
  guard
    let components = URLComponents(string: trimmed),
    components.scheme?.lowercased() == "http",
    let host = components.host?.lowercased(),
    ["127.0.0.1", "::1", "localhost"].contains(host),
    components.user == nil,
    components.password == nil,
    components.query == nil,
    components.fragment == nil
  else {
    return nil
  }
  return components.url?.absoluteString
}

final class SidecarClient: SidecarControlling {
  private enum Launch {
    case executable(URL)
    case node(node: URL, script: URL)
  }

  private let queue = DispatchQueue(label: "io.github.seoulpro.tallyburn.sidecar")
  private let timing: SidecarTiming
  private let isolatedConfigOverride: URL?
  private var process: Process?
  private var outputPipe: Pipe?
  private var errorPipe: Pipe?
  private var buffer = Data()
  private var intentionalStop = false
  private var isStopping = false
  private var failureReported = false
  private var generation: UInt64 = 0
  private var watchdogToken: UInt64 = 0
  private var stopCompletions: [() -> Void] = []
  private var killWorkItem: DispatchWorkItem?
  private var startupWatchdog: DispatchWorkItem?
  private var heartbeatWatchdog: DispatchWorkItem?

  init(
    timing: SidecarTiming = .production,
    isolatedConfigURL: URL? = nil
  ) {
    self.timing = timing
    isolatedConfigOverride = isolatedConfigURL
  }

  func start(
    configuration: SidecarConfiguration,
    onEnvelope: @escaping (SnapshotEnvelope) -> Void,
    onState: @escaping (SidecarState) -> Void
  ) {
    queue.async { [weak self] in
      guard let self else { return }
      self.generation &+= 1
      let requestedGeneration = self.generation
      self.stopLocked {
        guard self.generation == requestedGeneration else { return }
        self.launchLocked(
          configuration: configuration,
          generation: requestedGeneration,
          onEnvelope: onEnvelope,
          onState: onState
        )
      }
    }
  }

  func stop(completion: (() -> Void)? = nil) {
    queue.async { [weak self] in
      guard let self else {
        if let completion {
          DispatchQueue.main.async(execute: completion)
        }
        return
      }
      self.generation &+= 1
      self.stopLocked {
        if let completion {
          DispatchQueue.main.async(execute: completion)
        }
      }
    }
  }

  private func launchLocked(
    configuration: SidecarConfiguration,
    generation requestedGeneration: UInt64,
    onEnvelope: @escaping (SnapshotEnvelope) -> Void,
    onState: @escaping (SidecarState) -> Void
  ) {
    guard generation == requestedGeneration else { return }
    intentionalStop = false
    isStopping = false
    failureReported = false
    DispatchQueue.main.async {
      onState(.starting)
    }

    do {
      let launch = try resolveLaunch(configuration: configuration)
      let isolatedConfigURL = try prepareIsolatedConfig()
      let process = Process()
      let outputPipe = Pipe()
      let errorPipe = Pipe()
      let arguments = SidecarLaunchPolicy.arguments(
        for: configuration,
        isolatedConfigURL: isolatedConfigURL,
        codexExecutable: codexExecutable(),
        claudeExecutable: claudeExecutable()
      )

      switch launch {
      case .executable(let executable):
        process.executableURL = executable
        process.arguments = arguments
      case .node(let node, let script):
        process.executableURL = node
        process.arguments = [script.path] + arguments
      }
      process.standardOutput = outputPipe
      process.standardError = errorPipe
      process.standardInput = FileHandle.nullDevice
      process.environment = SidecarLaunchPolicy.sanitizedEnvironment(
        from: ProcessInfo.processInfo.environment
      )

      outputPipe.fileHandleForReading.readabilityHandler = {
        [weak self, weak process] handle in
        let data = handle.availableData
        guard !data.isEmpty, let process else { return }
        self?.queue.async {
          guard let self,
            self.process === process,
            self.generation == requestedGeneration,
            !self.isStopping
          else {
            return
          }
          self.consume(
            data,
            process: process,
            generation: requestedGeneration,
            onEnvelope: onEnvelope,
            onState: onState
          )
        }
      }
      errorPipe.fileHandleForReading.readabilityHandler = { handle in
        // Drain stderr so the helper cannot block. Never copy raw
        // helper output into app logs because it may contain paths.
        _ = handle.availableData
      }
      process.terminationHandler = { [weak self] process in
        self?.queue.async {
          self?.handleTerminationLocked(
            process,
            generation: requestedGeneration,
            onState: onState
          )
        }
      }

      self.process = process
      self.outputPipe = outputPipe
      self.errorPipe = errorPipe
      buffer.removeAll(keepingCapacity: true)
      try process.run()
      scheduleStartupWatchdog(
        process: process,
        generation: requestedGeneration,
        onState: onState
      )
    } catch {
      cancelWatchdogsLocked()
      process = nil
      clearHandlers()
      outputPipe = nil
      errorPipe = nil
      buffer.removeAll(keepingCapacity: false)
      failureReported = true
      DispatchQueue.main.async {
        onState(.failed(error.localizedDescription))
      }
    }
  }

  private func stopLocked(completion: (() -> Void)? = nil) {
    if let completion {
      stopCompletions.append(completion)
    }
    cancelWatchdogsLocked()
    clearHandlers()

    guard let process else {
      finishStopCompletionsLocked()
      return
    }
    intentionalStop = true
    guard !isStopping else { return }
    isStopping = true

    if process.isRunning {
      process.terminate()
      scheduleForcedTerminationLocked(for: process)
    } else {
      handleTerminationLocked(
        process, generation: generation,
        onState: {
          _ in
        })
    }
  }

  private func clearHandlers() {
    outputPipe?.fileHandleForReading.readabilityHandler = nil
    errorPipe?.fileHandleForReading.readabilityHandler = nil
  }

  private func consume(
    _ data: Data,
    process: Process,
    generation requestedGeneration: UInt64,
    onEnvelope: @escaping (SnapshotEnvelope) -> Void,
    onState: @escaping (SidecarState) -> Void
  ) {
    buffer.append(data)
    if buffer.count > 2 * 1024 * 1024 {
      buffer.removeAll(keepingCapacity: false)
      failCurrentLocked(
        localized(
          "sidecar.error.oversizedMessage",
          fallback: "Collection engine sent an oversized message."
        ),
        process: process,
        generation: requestedGeneration,
        onState: onState
      )
      return
    }

    while let newline = buffer.firstIndex(of: 0x0A) {
      let line = buffer[..<newline]
      buffer.removeSubrange(...newline)
      guard !line.isEmpty else { continue }
      do {
        let envelope = try JSONDecoder().decode(
          SnapshotEnvelope.self,
          from: Data(line)
        )
        guard envelope.schemaVersion == 1, envelope.type == "snapshot" else {
          throw SidecarError.incompatibleProtocol
        }
        startupWatchdog?.cancel()
        startupWatchdog = nil
        scheduleHeartbeatWatchdog(
          process: process,
          generation: requestedGeneration,
          onState: onState
        )
        DispatchQueue.main.async {
          onEnvelope(envelope)
          onState(.connected)
        }
      } catch {
        failCurrentLocked(
          localized(
            "sidecar.error.protocol",
            fallback: "Collection engine protocol error."
          ),
          process: process,
          generation: requestedGeneration,
          onState: onState
        )
        return
      }
    }
  }

  private func scheduleStartupWatchdog(
    process: Process,
    generation requestedGeneration: UInt64,
    onState: @escaping (SidecarState) -> Void
  ) {
    startupWatchdog?.cancel()
    watchdogToken &+= 1
    let scheduledToken = watchdogToken
    let workItem = DispatchWorkItem { [weak self, weak process] in
      guard let self, let process else { return }
      guard self.watchdogToken == scheduledToken else { return }
      self.failCurrentLocked(
        localized(
          "sidecar.error.startupTimeout",
          fallback:
            "Collection engine did not produce data in time."
        ),
        process: process,
        generation: requestedGeneration,
        onState: onState
      )
    }
    startupWatchdog = workItem
    queue.asyncAfter(
      deadline: .now() + timing.startupTimeout,
      execute: workItem
    )
  }

  private func scheduleHeartbeatWatchdog(
    process: Process,
    generation requestedGeneration: UInt64,
    onState: @escaping (SidecarState) -> Void
  ) {
    heartbeatWatchdog?.cancel()
    watchdogToken &+= 1
    let scheduledToken = watchdogToken
    let workItem = DispatchWorkItem { [weak self, weak process] in
      guard let self, let process else { return }
      guard self.watchdogToken == scheduledToken else { return }
      self.failCurrentLocked(
        localized(
          "sidecar.error.heartbeatTimeout",
          fallback: "Collection engine stopped responding."
        ),
        process: process,
        generation: requestedGeneration,
        onState: onState
      )
    }
    heartbeatWatchdog = workItem
    queue.asyncAfter(
      deadline: .now() + timing.heartbeatTimeout,
      execute: workItem
    )
  }

  private func failCurrentLocked(
    _ message: String,
    process: Process,
    generation requestedGeneration: UInt64,
    onState: @escaping (SidecarState) -> Void
  ) {
    guard self.process === process,
      generation == requestedGeneration,
      !isStopping,
      !failureReported
    else {
      return
    }
    failureReported = true
    DispatchQueue.main.async {
      onState(.failed(message))
    }
    stopLocked()
  }

  private func scheduleForcedTerminationLocked(for process: Process) {
    killWorkItem?.cancel()
    let workItem = DispatchWorkItem { [weak self, weak process] in
      guard let self,
        let process,
        self.process === process,
        process.isRunning
      else {
        return
      }
      kill(process.processIdentifier, SIGKILL)
    }
    killWorkItem = workItem
    queue.asyncAfter(
      deadline: .now() + timing.stopGracePeriod,
      execute: workItem
    )
  }

  private func handleTerminationLocked(
    _ terminatedProcess: Process,
    generation terminatedGeneration: UInt64,
    onState: @escaping (SidecarState) -> Void
  ) {
    guard process === terminatedProcess else { return }
    let shouldReportFailure = !intentionalStop && !failureReported
    cancelWatchdogsLocked()
    killWorkItem?.cancel()
    killWorkItem = nil
    clearHandlers()
    process = nil
    outputPipe = nil
    errorPipe = nil
    buffer.removeAll(keepingCapacity: false)
    isStopping = false
    intentionalStop = false

    if shouldReportFailure, generation == terminatedGeneration {
      failureReported = true
      DispatchQueue.main.async {
        onState(
          .failed(
            localizedFormat(
              "sidecar.error.exited",
              fallback: "Collection engine exited (%d).",
              terminatedProcess.terminationStatus
            )
          ))
      }
    }
    finishStopCompletionsLocked()
  }

  private func cancelWatchdogsLocked() {
    watchdogToken &+= 1
    startupWatchdog?.cancel()
    startupWatchdog = nil
    heartbeatWatchdog?.cancel()
    heartbeatWatchdog = nil
  }

  private func finishStopCompletionsLocked() {
    let completions = stopCompletions
    stopCompletions.removeAll(keepingCapacity: false)
    for completion in completions {
      completion()
    }
  }

  private func resolveLaunch(configuration: SidecarConfiguration) throws -> Launch {
    let environment = ProcessInfo.processInfo.environment
    if let scriptPath = environment["TALLYBURN_CLI_SCRIPT"],
      FileManager.default.fileExists(atPath: scriptPath),
      let node = SidecarLaunchPolicy.firstDistinctExecutable(
        preferred: environment["TALLYBURN_NODE_PATH"],
        candidates: [
          "/opt/homebrew/bin/node",
          "/usr/local/bin/node",
          "/usr/bin/node",
        ],
        from: Bundle.main.executableURL
      )
    {
      return .node(node: node, script: URL(fileURLWithPath: scriptPath))
    }

    if !configuration.cliPath.isEmpty {
      let path = NSString(string: configuration.cliPath)
        .expandingTildeInPath
      guard FileManager.default.fileExists(atPath: path) else {
        throw SidecarError.cliNotFound
      }
      let url = URL(fileURLWithPath: path)
      if url.pathExtension == "js" {
        guard
          let node = SidecarLaunchPolicy.firstDistinctExecutable(
            preferred: environment["TALLYBURN_NODE_PATH"],
            candidates: [
              "/opt/homebrew/bin/node",
              "/usr/local/bin/node",
              "/usr/bin/node",
            ],
            from: Bundle.main.executableURL
          )
        else {
          throw SidecarError.nodeNotFound
        }
        return .node(node: node, script: url)
      }
      guard FileManager.default.isExecutableFile(atPath: path) else {
        throw SidecarError.cliNotExecutable
      }
      guard
        SidecarLaunchPolicy.isDistinctExecutable(
          url,
          from: Bundle.main.executableURL
        )
      else {
        throw SidecarError.recursiveCLI
      }
      return .executable(url)
    }

    if let bundled = Bundle.main.url(forAuxiliaryExecutable: "tallyburn"),
      SidecarLaunchPolicy.isDistinctExecutable(
        bundled,
        from: Bundle.main.executableURL
      )
    {
      return .executable(bundled)
    }
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    if let cli = SidecarLaunchPolicy.firstDistinctExecutable(
      preferred: environment["TALLYBURN_CLI_PATH"],
      candidates: [
        "/opt/homebrew/bin/tallyburn",
        "/usr/local/bin/tallyburn",
        "\(home)/Library/pnpm/tallyburn",
        "\(home)/.local/share/pnpm/tallyburn",
      ],
      from: Bundle.main.executableURL
    ) {
      return .executable(cli)
    }
    throw SidecarError.cliNotFound
  }

  private func codexExecutable() -> URL? {
    let environment = ProcessInfo.processInfo.environment
    return SidecarLaunchPolicy.firstDistinctExecutable(
      preferred: environment["TALLYBURN_CODEX_EXECUTABLE"],
      candidates: [
        "/Applications/ChatGPT.app/Contents/Resources/codex",
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex",
      ],
      from: Bundle.main.executableURL
    )
  }

  private func claudeExecutable() -> URL? {
    let environment = ProcessInfo.processInfo.environment
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    return SidecarLaunchPolicy.firstDistinctExecutable(
      preferred: environment["TALLYBURN_CLAUDE_EXECUTABLE"],
      candidates: [
        "\(home)/.local/bin/claude",
        "\(home)/.claude/local/claude",
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
      ],
      from: Bundle.main.executableURL
    )
  }

  private func prepareIsolatedConfig() throws -> URL {
    if let isolatedConfigOverride {
      return try writeIsolatedConfig(to: isolatedConfigOverride)
    }
    if let bundled = Bundle.main.url(
      forResource: "sidecar-defaults",
      withExtension: "json"
    ) {
      return bundled
    }
    guard
      let applicationSupport = FileManager.default.urls(
        for: .applicationSupportDirectory,
        in: .userDomainMask
      ).first
    else {
      throw SidecarError.isolatedConfigUnavailable
    }
    return try writeIsolatedConfig(
      to:
        applicationSupport
        .appendingPathComponent("Tallyburn", isDirectory: true)
        .appendingPathComponent(
          "sidecar-config.json",
          isDirectory: false
        )
    )
  }

  private func writeIsolatedConfig(to configURL: URL) throws -> URL {
    let directory = configURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o700],
      ofItemAtPath: directory.path
    )
    try Data("{}".utf8).write(to: configURL, options: .atomic)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o600],
      ofItemAtPath: configURL.path
    )
    return configURL
  }
}

private enum SidecarError: LocalizedError {
  case cliNotFound
  case cliNotExecutable
  case recursiveCLI
  case nodeNotFound
  case incompatibleProtocol
  case isolatedConfigUnavailable

  var errorDescription: String? {
    switch self {
    case .cliNotFound:
      return localized(
        "sidecar.error.cliNotFound",
        fallback:
          "Tallyburn CLI was not found. Set its path in Settings."
      )
    case .cliNotExecutable:
      return localized(
        "sidecar.error.cliNotExecutable",
        fallback: "The selected Tallyburn CLI is not executable."
      )
    case .recursiveCLI:
      return localized(
        "sidecar.error.recursiveCLI",
        fallback:
          "The Tallyburn CLI path cannot point to the app executable."
      )
    case .nodeNotFound:
      return localized(
        "sidecar.error.nodeNotFound",
        fallback:
          "Node.js was not found for the selected CLI script."
      )
    case .incompatibleProtocol:
      return localized(
        "sidecar.error.incompatibleProtocol",
        fallback: "The collection engine uses an incompatible protocol."
      )
    case .isolatedConfigUnavailable:
      return localized(
        "sidecar.error.isolatedConfig",
        fallback:
          "Tallyburn could not create its isolated collection-engine configuration."
      )
    }
  }
}

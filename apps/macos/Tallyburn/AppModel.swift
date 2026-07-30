import AppKit
import Foundation
import ServiceManagement

@MainActor
final class AppModel: ObservableObject {
  @Published private(set) var snapshot: UsageSnapshotDTO?
  @Published private(set) var state: SidecarState = .idle
  @Published private(set) var hasMonitoringConsent: Bool
  @Published var selectedWindow: String
  @Published var mode: MonitoringMode
  @Published var windows: String
  @Published var codexAccount: Bool
  @Published var otelMetrics: Bool
  @Published var llamaCppMetricsURL: String
  @Published var vllmMetricsURL: String
  @Published var cliPath: String
  @Published var launchAtLogin: Bool
  @Published private(set) var showRateInMenuBar: Bool
  @Published private(set) var miniMonitorEnabled: Bool
  @Published private(set) var providerColors: [String: String]
  @Published var settingsError: String? {
    didSet {
      guard settingsError != oldValue,
        let settingsError
      else {
        return
      }
      NSAccessibility.post(
        element: NSApplication.shared,
        notification: .announcementRequested,
        userInfo: [
          .announcement: settingsError,
          .priority: NSAccessibilityPriorityLevel.high.rawValue,
        ]
      )
    }
  }

  private let defaults: UserDefaults
  private let client: SidecarControlling
  private let reconnectDelays: [Duration]
  private let terminateApplication: () -> Void
  private var isPaused = false
  private var restartAttempts = 0
  private var connectionGeneration: UInt64 = 0
  private var reconnectTask: Task<Void, Never>?

  init(
    defaults: UserDefaults = .standard,
    client: SidecarControlling = SidecarClient(),
    automaticallyStartsMonitoring: Bool = true,
    reconnectDelays: [Duration] = [
      .seconds(2),
      .seconds(5),
      .seconds(15),
    ],
    terminateApplication: @escaping () -> Void = {
      Task { @MainActor in
        NSApplication.shared.terminate(nil)
      }
    }
  ) {
    self.defaults = defaults
    self.client = client
    self.reconnectDelays = reconnectDelays
    self.terminateApplication = terminateApplication
    hasMonitoringConsent = defaults.bool(forKey: "monitoringConsent")
    selectedWindow = defaults.string(forKey: "selectedWindow") ?? "1h"
    mode =
      MonitoringMode(
        rawValue: defaults.string(forKey: "monitoringMode") ?? ""
      ) ?? .standard
    windows = defaults.string(forKey: "windows") ?? "1h,3h,12h"
    codexAccount = defaults.bool(forKey: "codexAccount")
    otelMetrics = defaults.bool(forKey: "otelMetrics")
    llamaCppMetricsURL =
      defaults.string(forKey: "llamaCppMetricsURL") ?? ""
    vllmMetricsURL = defaults.string(forKey: "vllmMetricsURL") ?? ""
    cliPath = defaults.string(forKey: "cliPath") ?? ""
    launchAtLogin = SMAppService.mainApp.status == .enabled
    showRateInMenuBar = defaults.bool(forKey: "showRateInMenuBar")
    miniMonitorEnabled = defaults.bool(forKey: "miniMonitorEnabled")
    providerColors = loadProviderColorOverrides(
      defaults.dictionary(forKey: "providerColors")
    )
    if hasMonitoringConsent, automaticallyStartsMonitoring {
      start()
    }
  }

  var menuIcon: String {
    switch state {
    case .connected:
      return menuActivityValue > 0 ? "flame.fill" : "flame"
    case .starting: return "flame"
    case .paused: return "pause.circle"
    case .failed: return "exclamationmark.triangle"
    case .idle: return "flame"
    }
  }

  var menuTitle: String {
    guard hasMonitoringConsent, snapshot != nil else { return "" }
    return localizedFormat(
      "unit.perSecond.compact",
      fallback: "%@/s",
      menuAverageTokensPerSecond.map(formatRateValue) ?? "—"
    )
  }

  /// The menu bar has one stable unit contract. New helpers provide the exact
  /// recent tokens-per-second value; older helpers expose the same moving
  /// average per minute, which is normalized here rather than changing the
  /// menu title's unit at runtime.
  var menuAverageTokensPerSecond: Double? {
    if let currentReportedTokensPerSecond {
      return currentReportedTokensPerSecond
    }
    guard let currentObservedPace else { return nil }
    return Double(currentObservedPace) / 60
  }

  var accessibilityLabel: String {
    guard snapshot != nil else {
      return localized(
        "accessibility.monitor.title",
        fallback: "Tallyburn token activity monitor"
      )
    }
    guard let currentObservedPace else {
      var label = localizedFormat(
        "accessibility.monitor.unavailable",
        fallback:
          "Tallyburn token activity monitor. Live rate unavailable while %@",
        rateAvailabilityLabel
      )
      if let selectedAggregate {
        label += localizedFormat(
          "accessibility.monitor.lastTotal",
          fallback: ". Last recorded %@ total %lld tokens",
          selectedWindow,
          selectedAggregate.total
        )
      }
      return label
    }
    let paceBasis: String
    if let liveRate = snapshot?.liveRate {
      paceBasis = localizedFormat(
        "accessibility.paceBasis.trailing",
        fallback: "over the last %@",
        formatSpokenRateWindow(liveRate.trailingWindowMs)
      )
    } else {
      paceBasis = localizedFormat(
        "accessibility.paceBasis.average",
        fallback: "averaged over the last %@",
        formatSpokenRateWindow(recentPaceWindowMs)
      )
    }
    var label: String
    if let currentReportedTokensPerSecond,
      let liveActivity = snapshot?.liveActivity
    {
      label = localizedFormat(
        "accessibility.monitor.live",
        fallback:
          "Completed-response token activity %@ tokens per second averaged over the last %@",
        formatRateValue(currentReportedTokensPerSecond),
        formatSpokenRateWindow(liveActivity.rateWindowMs)
      )
    } else {
      label = localizedFormat(
        "accessibility.monitor.pace",
        fallback:
          "Observed token pace %lld tokens per minute %@ from reported responses",
        currentObservedPace,
        paceBasis
      )
    }
    if let selectedAggregate {
      label += localizedFormat(
        "accessibility.monitor.total",
        fallback: ". %@ total %lld tokens",
        selectedWindow,
        selectedAggregate.total
      )
    }
    return label
  }

  var selectedWindowSnapshot: WindowAggregateDTO? {
    snapshot?.windows.first(where: { $0.label == selectedWindow })
      ?? snapshot?.windows.first
  }

  var selectedAggregate: ProviderAggregateDTO? {
    selectedWindowSnapshot?.all
  }

  var configurableProviders: [String] {
    var providers = Set([
      "codex", "claude", "gemini", "copilot", "qwen", "llamacpp", "vllm",
    ])
    for window in snapshot?.windows ?? [] {
      for (provider, aggregate) in window.providers
      where aggregate.observations > 0 || aggregate.total > 0 {
        providers.insert(provider)
      }
    }
    if let liveRate = snapshot?.liveRate {
      for (provider, aggregate) in liveRate.providers
      where aggregate.observations > 0 || aggregate.observedTokens > 0 {
        providers.insert(provider)
      }
    }
    if let liveActivity = snapshot?.liveActivity {
      for (provider, aggregate) in liveActivity.providers
      where aggregate.observations > 0 || aggregate.observedTokens > 0 {
        providers.insert(provider)
      }
    }
    if let snapshot {
      providers.formUnion(snapshot.quotas.keys)
      if let accounts = snapshot.accounts {
        providers.formUnion(accounts.keys)
      }
      for (provider, source) in snapshot.sources
      where source.available || source.lastEventAt != nil {
        providers.insert(provider)
      }
    }
    return canonicalProviderOrder(Array(providers))
  }

  var recentPace: Int64 {
    snapshot?.recentTokensPerMinute ?? 0
  }

  var recentPaceWindowMs: Double {
    snapshot?.recentRateWindowMs ?? 5 * 60_000
  }

  var recentPaceWindowLabel: String {
    formatRateWindow(recentPaceWindowMs)
  }

  var observedPace: Int64 {
    snapshot?.liveRate?.all.tokensPerMinute ?? recentPace
  }

  var liveActivity: LiveActivityDTO? {
    snapshot?.liveActivity
  }

  var currentReportedTokensPerSecond: Double? {
    guard case .connected = state,
      let liveActivity = snapshot?.liveActivity
    else {
      return nil
    }
    return liveActivity.all.tokensPerSecond
  }

  var liveActivityCaption: String {
    guard let liveActivity = snapshot?.liveActivity else {
      return localized(
        "liveActivity.historyUnavailable",
        fallback: "Live history unavailable"
      )
    }
    let hasRateHistory =
      liveActivity.rateSeries?["all"]?.isEmpty == false
    let rateWindowLabel = formatRateWindow(liveActivity.rateWindowMs)
    let sampleIntervalLabel = formatRateWindow(
      liveActivity.sampleIntervalMs
    )
    let basis =
      hasRateHistory
      ? localizedFormat(
        "liveActivity.caption.movingRate",
        fallback: "%@ moving rate · %@ refresh",
        rateWindowLabel,
        sampleIntervalLabel
      )
      : localizedFormat(
        "liveActivity.caption.buckets",
        fallback: "%@ buckets · %@ headline",
        sampleIntervalLabel,
        rateWindowLabel
      )
    guard currentReportedTokensPerSecond != nil else {
      return localizedFormat(
        "liveActivity.caption.lastKnown",
        fallback: "last known · %@",
        rateAvailabilityLabel
      )
    }
    if currentReportedTokensPerSecond == 0 {
      return localizedFormat(
        "liveActivity.caption.noReport",
        fallback: "no completed report · last %@",
        rateWindowLabel
      )
    }
    return basis
  }

  var liveActivityHelp: String {
    guard let liveActivity = snapshot?.liveActivity else {
      return localized(
        "liveActivity.help.unavailable",
        fallback:
          "This collection engine does not provide one-second token activity history."
      )
    }
    let graphDescription: String
    if liveActivity.rateSeries?["all"]?.isEmpty == false {
      graphDescription = localizedFormat(
        "liveActivity.help.rateSeries",
        fallback:
          "The graph samples the exact trailing %@ rate every %@. Raw reports are also retained in one-second buckets. ",
        formatSpokenRateWindow(liveActivity.rateWindowMs),
        formatSpokenRateWindow(liveActivity.sampleIntervalMs)
      )
    } else {
      graphDescription = localizedFormat(
        "liveActivity.help.legacySeries",
        fallback:
          "This older collection engine graphs raw reports in %@ buckets. The headline is the exact trailing %@ rate. ",
        formatSpokenRateWindow(liveActivity.sampleIntervalMs),
        formatSpokenRateWindow(liveActivity.rateWindowMs)
      )
    }
    return graphDescription
      + localized(
        "liveActivity.help.reporting",
        fallback:
          "Providers usually report usage after a response or telemetry batch completes, so this is not in-flight generation speed or plan quota. Zero means no supported client reported a completed response in that trailing window; a response can still be running."
      )
  }

  var isCurrentlyReportingActivity: Bool {
    guard case .connected = state else { return false }
    if snapshot?.liveActivity != nil {
      return (currentReportedTokensPerSecond ?? 0) > 0
    }
    return (currentObservedPace ?? 0) > 0
  }

  var currentObservedPace: Int64? {
    guard case .connected = state, snapshot != nil else { return nil }
    return observedPace
  }

  var observedPaceCaption: String {
    guard currentObservedPace != nil else {
      return localizedFormat(
        "liveActivity.caption.lastKnown",
        fallback: "last known · %@",
        rateAvailabilityLabel
      )
    }
    guard let liveRate = snapshot?.liveRate else {
      return localizedFormat(
        "observedPace.caption.average",
        fallback: "%@ average · updates every 1s",
        recentPaceWindowLabel
      )
    }
    return localizedFormat(
      "observedPace.caption.trailing",
      fallback: "last %@ · updates every 1s",
      formatRateWindow(liveRate.trailingWindowMs)
    )
  }

  var observedPaceHelp: String {
    let limitation = localized(
      "observedPace.help.limitation",
      fallback:
        " This is not in-flight generation speed or plan quota."
    )
    if let liveRate = snapshot?.liveRate {
      return localizedFormat(
        "observedPace.help.trailing",
        fallback:
          "Raw tokens reported by completed responses and telemetry during the trailing %@.",
        formatSpokenRateWindow(liveRate.trailingWindowMs)
      )
        + limitation
    }
    return localizedFormat(
      "observedPace.help.legacy",
      fallback:
        "Average raw tokens reported by completed responses and telemetry during the last %@. This older collection engine does not provide the one-minute observed pace.",
      formatSpokenRateWindow(recentPaceWindowMs)
    )
      + limitation
  }

  var hasLiveRate: Bool {
    snapshot?.liveRate != nil
  }

  var lastObservedEventAt: Double? {
    snapshot?.liveRate?.all.lastEventAt ?? selectedAggregate?.lastEventAt
  }

  func observedPace(for provider: String) -> Int64? {
    guard currentObservedPace != nil else { return nil }
    return snapshot?.liveRate?.providers[provider]?.tokensPerMinute
  }

  func reportedTokensPerSecond(for provider: String) -> Double? {
    guard currentReportedTokensPerSecond != nil else { return nil }
    return snapshot?.liveActivity?
      .providers[provider]?.tokensPerSecond
  }

  var paused: Bool { isPaused }

  func enableMonitoring(_ selectedMode: MonitoringMode) {
    mode = selectedMode
    hasMonitoringConsent = true
    persist()
    start()
  }

  func start() {
    guard hasMonitoringConsent, !isPaused else { return }
    cancelReconnect(resetAttempts: false)
    connectionGeneration &+= 1
    let requestedGeneration = connectionGeneration
    state = .starting
    client.start(
      configuration: configuration,
      onEnvelope: { [weak self] envelope in
        guard let self,
          self.connectionGeneration == requestedGeneration
        else {
          return
        }
        self.snapshot = envelope.snapshot
        self.cancelReconnect(resetAttempts: true)
        if !envelope.snapshot.windows.contains(where: {
          $0.label == self.selectedWindow
        }) {
          self.selectedWindow =
            envelope.snapshot.windows.first?.label ?? "1h"
        }
      },
      onState: { [weak self] newState in
        guard let self,
          self.connectionGeneration == requestedGeneration
        else {
          return
        }
        self.state = newState
        switch newState {
        case .connected:
          self.cancelReconnect(resetAttempts: true)
        case .failed:
          self.scheduleReconnect()
        default:
          break
        }
      }
    )
  }

  func restart() {
    isPaused = false
    cancelReconnect(resetAttempts: true)
    start()
  }

  func togglePause() {
    isPaused.toggle()
    if isPaused {
      connectionGeneration &+= 1
      cancelReconnect(resetAttempts: true)
      client.stop()
      state = .paused
    } else {
      start()
    }
  }

  @discardableResult
  func applySettings(
    mode: MonitoringMode,
    windows: String,
    codexAccount: Bool,
    otelMetrics: Bool = false,
    llamaCppMetricsURL: String = "",
    vllmMetricsURL: String = "",
    cliPath: String
  ) -> Bool {
    guard
      let normalizedWindows =
        RollingWindowConfiguration.normalize(windows)
    else {
      settingsError =
        localized(
          "settings.error.windows",
          fallback:
            "Use 1–6 unique durations such as 1h,3h,12h (maximum 30d)."
        )
      return false
    }
    let normalizedCLIPath =
      cliPath
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if !normalizedCLIPath.isEmpty {
      let expanded = NSString(string: normalizedCLIPath)
        .expandingTildeInPath
      guard FileManager.default.fileExists(atPath: expanded) else {
        settingsError = localized(
          "settings.error.cliNotFound",
          fallback:
            "The selected Tallyburn CLI path does not exist."
        )
        return false
      }
    }
    guard
      let normalizedLlamaCppMetricsURL =
        normalizedLocalMetricsURL(llamaCppMetricsURL),
      let normalizedVLLMMetricsURL =
        normalizedLocalMetricsURL(vllmMetricsURL)
    else {
      settingsError = localized(
        "settings.error.localMetricsURL",
        fallback:
          "Use an unauthenticated local HTTP URL such as http://127.0.0.1:8080/metrics."
      )
      return false
    }
    let monitoringNeedsRestart =
      !hasMonitoringConsent
      || self.mode != mode
      || self.windows != normalizedWindows
      || self.codexAccount != codexAccount
      || self.otelMetrics != otelMetrics
      || self.llamaCppMetricsURL != normalizedLlamaCppMetricsURL
      || self.vllmMetricsURL != normalizedVLLMMetricsURL
      || self.cliPath != normalizedCLIPath
    self.mode = mode
    self.windows = normalizedWindows
    self.codexAccount = codexAccount
    self.otelMetrics = otelMetrics
    self.llamaCppMetricsURL = normalizedLlamaCppMetricsURL
    self.vllmMetricsURL = normalizedVLLMMetricsURL
    self.cliPath = normalizedCLIPath
    hasMonitoringConsent = true
    settingsError = nil
    persist()
    if monitoringNeedsRestart {
      restart()
    }
    return true
  }

  func clearSettingsError() {
    settingsError = nil
  }

  func setSelectedWindow(_ label: String) {
    selectedWindow = label
    defaults.set(label, forKey: "selectedWindow")
  }

  func setShowRateInMenuBar(_ enabled: Bool) {
    showRateInMenuBar = enabled
    defaults.set(enabled, forKey: "showRateInMenuBar")
  }

  func setMiniMonitorEnabled(_ enabled: Bool) {
    miniMonitorEnabled = enabled
    defaults.set(enabled, forKey: "miniMonitorEnabled")
  }

  func setProviderColors(_ colors: [String: String]) {
    providerColors = normalizedProviderColorOverrides(colors)
    defaults.set(providerColors, forKey: "providerColors")
  }

  func setLaunchAtLogin(_ enabled: Bool) {
    do {
      if enabled {
        try SMAppService.mainApp.register()
      } else {
        try SMAppService.mainApp.unregister()
      }
      let status = SMAppService.mainApp.status
      launchAtLogin = status == .enabled
      settingsError =
        status == .requiresApproval
        ? localized(
          "settings.error.loginApproval",
          fallback:
            "Allow Tallyburn in System Settings → General → Login Items."
        )
        : nil
    } catch {
      launchAtLogin = SMAppService.mainApp.status == .enabled
      settingsError = localized(
        "settings.error.loginChange",
        fallback: "Launch at login could not be changed."
      )
    }
  }

  func quit() {
    connectionGeneration &+= 1
    cancelReconnect(resetAttempts: true)
    client.stop { [terminateApplication] in
      terminateApplication()
    }
  }

  private var configuration: SidecarConfiguration {
    SidecarConfiguration(
      cliPath: cliPath,
      windows: windows,
      mode: mode,
      codexAccount: codexAccount,
      otelMetrics: otelMetrics,
      llamaCppMetricsURL: llamaCppMetricsURL,
      vllmMetricsURL: vllmMetricsURL
    )
  }

  private func persist() {
    defaults.set(hasMonitoringConsent, forKey: "monitoringConsent")
    defaults.set(mode.rawValue, forKey: "monitoringMode")
    defaults.set(windows, forKey: "windows")
    defaults.set(codexAccount, forKey: "codexAccount")
    defaults.set(otelMetrics, forKey: "otelMetrics")
    defaults.set(llamaCppMetricsURL, forKey: "llamaCppMetricsURL")
    defaults.set(vllmMetricsURL, forKey: "vllmMetricsURL")
    defaults.set(cliPath, forKey: "cliPath")
    defaults.set(selectedWindow, forKey: "selectedWindow")
    defaults.set(showRateInMenuBar, forKey: "showRateInMenuBar")
    defaults.set(miniMonitorEnabled, forKey: "miniMonitorEnabled")
    defaults.set(providerColors, forKey: "providerColors")
  }

  private func scheduleReconnect() {
    guard !isPaused,
      reconnectTask == nil,
      restartAttempts < reconnectDelays.count
    else {
      return
    }
    restartAttempts += 1
    let delay = reconnectDelays[restartAttempts - 1]
    let scheduledGeneration = connectionGeneration
    reconnectTask = Task { [weak self] in
      do {
        try await Task.sleep(for: delay)
      } catch {
        return
      }
      guard !Task.isCancelled,
        let self,
        self.connectionGeneration == scheduledGeneration,
        !self.isPaused,
        case .failed = self.state
      else {
        return
      }
      self.reconnectTask = nil
      self.start()
    }
  }

  private func cancelReconnect(resetAttempts: Bool) {
    reconnectTask?.cancel()
    reconnectTask = nil
    if resetAttempts {
      restartAttempts = 0
    }
  }

  private var rateAvailabilityLabel: String {
    switch state {
    case .idle:
      return localized(
        "availability.idle",
        fallback: "idle"
      )
    case .starting:
      return localized(
        "availability.reconnecting",
        fallback: "reconnecting"
      )
    case .connected:
      return localized(
        "availability.connected",
        fallback: "connected"
      )
    case .paused:
      return localized(
        "availability.paused",
        fallback: "paused"
      )
    case .failed:
      return localized(
        "availability.unavailable",
        fallback: "the connection is unavailable"
      )
    }
  }

  private var menuActivityValue: Double {
    menuAverageTokensPerSecond ?? 0
  }
}

func formatCompact(_ value: Int64) -> String {
  switch value {
  case 1_000_000_000...:
    return String(format: "%.2fB", Double(value) / 1_000_000_000)
  case 1_000_000...:
    return String(format: "%.2fM", Double(value) / 1_000_000)
  case 1_000...:
    return String(format: "%.1fK", Double(value) / 1_000)
  default:
    return "\(value)"
  }
}

func formatRateWindow(_ milliseconds: Double) -> String {
  let seconds = milliseconds / 1_000
  if seconds >= 60,
    seconds.truncatingRemainder(dividingBy: 60) == 0
  {
    return "\(Int(seconds / 60))m"
  }
  return "\(Int(seconds.rounded()))s"
}

func formatRateValue(_ value: Double) -> String {
  if value == 0 {
    return "0"
  }
  if value >= 100 {
    return formatCompact(Int64(value.rounded()))
  }
  if value >= 10 {
    if value == value.rounded() {
      return String(Int(value))
    }
    return String(format: "%.1f", value)
  }
  return String(format: "%.2f", value)
}

private func formatSpokenRateWindow(_ milliseconds: Double) -> String {
  let seconds = max(0, Int((milliseconds / 1_000).rounded()))
  if seconds >= 60, seconds.isMultiple(of: 60) {
    let minutes = seconds / 60
    return localizedFormat(
      minutes == 1
        ? "rateWindow.minute.one"
        : "rateWindow.minute.other",
      fallback: minutes == 1 ? "%d minute" : "%d minutes",
      minutes
    )
  }
  return localizedFormat(
    seconds == 1
      ? "rateWindow.second.one"
      : "rateWindow.second.other",
    fallback: seconds == 1 ? "%d second" : "%d seconds",
    seconds
  )
}

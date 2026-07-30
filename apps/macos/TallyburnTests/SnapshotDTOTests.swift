import AppKit
import SwiftUI
import XCTest

@testable import Tallyburn

final class SnapshotDTOTests: XCTestCase {
  func testDecodesVersionedSnapshotEnvelope() throws {
    let json = """
      {
        "schemaVersion": 1,
        "type": "snapshot",
        "sequence": 3,
        "snapshot": {
          "generatedAt": 1000,
          "windows": [{
            "label": "1h",
            "durationMs": 3600000,
            "all": {
              "provider": "all",
              "observations": 1,
              "freshInput": 5,
              "cacheRead": 3,
              "cacheWrite": 0,
              "output": 2,
              "reasoning": 0,
              "total": 10
            },
            "providers": {
              "codex": {
                "provider": "codex",
                "observations": 1,
                "freshInput": 5,
                "cacheRead": 3,
                "cacheWrite": 0,
                "output": 2,
                "reasoning": 0,
                "total": 10
              }
            }
          }],
          "focusWindow": "1h",
          "recentTokensPerMinute": 2,
          "series": {
            "all": [],
            "codex": [],
            "claude": []
          },
          "quotas": {},
          "accounts": {
            "claude": {
              "provider": "claude",
              "observedAt": 900,
              "loggedIn": true,
              "subscriptionType": "max"
            }
          },
          "sources": {
            "codex": {
              "provider": "codex",
              "available": true,
              "filesSeen": 1,
              "filesRead": 1,
              "malformedLines": 0
            },
            "claude": {
              "provider": "claude",
              "available": false,
              "filesSeen": 0,
              "filesRead": 0,
              "malformedLines": 0
            }
          }
        }
      }
      """
    let envelope = try JSONDecoder().decode(
      SnapshotEnvelope.self,
      from: Data(json.utf8)
    )

    XCTAssertEqual(envelope.schemaVersion, 1)
    XCTAssertEqual(envelope.sequence, 3)
    XCTAssertEqual(envelope.snapshot.windows.first?.all.total, 10)
    XCTAssertNil(envelope.snapshot.recentRateWindowMs)
    XCTAssertNil(envelope.snapshot.liveRate)
    XCTAssertNil(envelope.snapshot.liveActivity)
    XCTAssertEqual(
      envelope.snapshot.accounts?["claude"]?.subscriptionType,
      "max"
    )
  }

  func testDecodesOptionalTrailingLiveRate() throws {
    let json = """
      {
        "schemaVersion": 1,
        "type": "snapshot",
        "sequence": 4,
        "snapshot": {
          "generatedAt": 2000,
          "windows": [],
          "focusWindow": "1h",
          "recentTokensPerMinute": 90,
          "recentRateWindowMs": 300000,
          "liveRate": {
            "trailingWindowMs": 60000,
            "all": {
              "provider": "all",
              "observedTokens": 1200,
              "tokensPerMinute": 1200,
              "observations": 2,
              "lastEventAt": 1900
            },
            "providers": {
              "codex": {
                "provider": "codex",
                "observedTokens": 600,
                "tokensPerMinute": 600,
                "observations": 1,
                "lastEventAt": 1900
              },
              "claude": {
                "provider": "claude",
                "observedTokens": 600,
                "tokensPerMinute": 600,
                "observations": 1,
                "lastEventAt": 1800
              }
            }
          },
          "liveActivity": {
            "historyWindowMs": 60000,
            "sampleIntervalMs": 1000,
            "rateWindowMs": 60000,
            "all": {
              "provider": "all",
              "observedTokens": 1200,
              "tokensPerSecond": 20,
              "observations": 2,
              "lastEventAt": 1900
            },
            "providers": {
              "codex": {
                "provider": "codex",
                "observedTokens": 600,
                "tokensPerSecond": 10,
                "observations": 1,
                "lastEventAt": 1900
              },
              "claude": {
                "provider": "claude",
                "observedTokens": 600,
                "tokensPerSecond": 10,
                "observations": 1,
                "lastEventAt": 1800
              }
            },
            "series": {
              "all": [
                { "start": 1000, "tokens": 600 },
                { "start": 2000, "tokens": 600 }
              ],
              "codex": [
                { "start": 1000, "tokens": 0 },
                { "start": 2000, "tokens": 600 }
              ],
              "claude": [
                { "start": 1000, "tokens": 600 },
                { "start": 2000, "tokens": 0 }
              ]
            },
            "rateSeries": {
              "all": [
                { "at": 1000, "tokensPerSecond": 10 },
                { "at": 2000, "tokensPerSecond": 20 }
              ],
              "codex": [
                { "at": 1000, "tokensPerSecond": 0 },
                { "at": 2000, "tokensPerSecond": 10 }
              ],
              "claude": [
                { "at": 1000, "tokensPerSecond": 10 },
                { "at": 2000, "tokensPerSecond": 10 }
              ]
            }
          },
          "series": {},
          "quotas": {},
          "sources": {}
        }
      }
      """
    let envelope = try JSONDecoder().decode(
      SnapshotEnvelope.self,
      from: Data(json.utf8)
    )

    let liveRate = try XCTUnwrap(envelope.snapshot.liveRate)
    XCTAssertEqual(liveRate.trailingWindowMs, 60_000)
    XCTAssertEqual(liveRate.all.observedTokens, 1_200)
    XCTAssertEqual(liveRate.all.tokensPerMinute, 1_200)
    XCTAssertEqual(liveRate.all.observations, 2)
    XCTAssertEqual(envelope.snapshot.recentRateWindowMs, 300_000)
    XCTAssertEqual(
      liveRate.providers["codex"]?.tokensPerMinute,
      600
    )
    let activity = try XCTUnwrap(envelope.snapshot.liveActivity)
    XCTAssertEqual(activity.historyWindowMs, 60_000)
    XCTAssertEqual(activity.sampleIntervalMs, 1_000)
    XCTAssertEqual(activity.rateWindowMs, 60_000)
    XCTAssertEqual(activity.all.tokensPerSecond, 20)
    XCTAssertEqual(
      activity.providers["codex"]?.tokensPerSecond,
      10
    )
    XCTAssertEqual(activity.series["all"]?.count, 2)
    XCTAssertEqual(activity.rateSeries?["all"]?.count, 2)
    XCTAssertEqual(
      activity.rateSeries?["all"]?.last?.tokensPerSecond,
      activity.all.tokensPerSecond
    )
  }
}

final class SidecarLaunchPolicyTests: XCTestCase {
  func testBundledHelperMustBeDistinctFromTheAppExecutable() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true
    )
    defer { try? FileManager.default.removeItem(at: directory) }

    let appExecutable = directory.appendingPathComponent("Tallyburn")
    let sameFileCandidate = directory.appendingPathComponent("helper-alias")
    let symlinkCandidate = directory.appendingPathComponent("helper-link")
    let distinctCandidate = directory.appendingPathComponent("helper")
    for executable in [appExecutable, distinctCandidate] {
      try Data("#!/bin/sh\n".utf8).write(to: executable)
      try FileManager.default.setAttributes(
        [.posixPermissions: 0o700],
        ofItemAtPath: executable.path
      )
    }
    try FileManager.default.linkItem(
      at: appExecutable,
      to: sameFileCandidate
    )
    try FileManager.default.createSymbolicLink(
      at: symlinkCandidate,
      withDestinationURL: appExecutable
    )

    XCTAssertFalse(
      SidecarLaunchPolicy.isDistinctExecutable(
        sameFileCandidate,
        from: appExecutable
      )
    )
    XCTAssertTrue(
      SidecarLaunchPolicy.isDistinctExecutable(
        distinctCandidate,
        from: appExecutable
      )
    )
    XCTAssertFalse(
      SidecarLaunchPolicy.isDistinctExecutable(
        symlinkCandidate,
        from: appExecutable
      )
    )
    XCTAssertEqual(
      SidecarLaunchPolicy.firstDistinctExecutable(
        preferred: sameFileCandidate.path,
        candidates: [
          symlinkCandidate.path,
          distinctCandidate.path,
        ],
        from: appExecutable
      ),
      distinctCandidate
    )
  }

  func testAppBundlesAnEmptySidecarConfiguration() throws {
    let url = try XCTUnwrap(
      Bundle.main.url(
        forResource: "sidecar-defaults",
        withExtension: "json"
      )
    )
    XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "{}\n")
  }

  func testAppBundlesIconAndKoreanLocalization() {
    XCTAssertNotNil(
      Bundle.main.url(
        forResource: "AppIcon",
        withExtension: "icns"
      )
    )
    XCTAssertNotNil(
      Bundle.main.url(
        forResource: "ko",
        withExtension: "lproj"
      )
    )
  }

  func testStandardModeDiscoversClaudePlanWithoutEnablingCodexAccount() {
    let arguments = SidecarLaunchPolicy.arguments(
      for: SidecarConfiguration(
        cliPath: "",
        windows: "1h,3h",
        mode: .standard,
        codexAccount: false
      ),
      isolatedConfigURL: URL(fileURLWithPath: "/tmp/isolated.json"),
      codexExecutable: URL(fileURLWithPath: "/tmp/codex"),
      claudeExecutable: URL(fileURLWithPath: "/tmp/claude")
    )

    XCTAssertTrue(containsOption(arguments, "--config", "/tmp/isolated.json"))
    XCTAssertTrue(containsOption(arguments, "--providers", "codex,claude"))
    XCTAssertTrue(arguments.contains("--no-codex-account"))
    XCTAssertTrue(arguments.contains("--claude-account"))
    XCTAssertTrue(
      containsOption(arguments, "--claude-executable", "/tmp/claude")
    )
    XCTAssertFalse(arguments.contains("--offline"))
    XCTAssertFalse(arguments.contains("--codex-account"))
    XCTAssertFalse(arguments.contains("--otel-port"))
  }

  func testMetricsOnlyModeCannotBeExpandedByAccountPreference() {
    let arguments = SidecarLaunchPolicy.arguments(
      for: SidecarConfiguration(
        cliPath: "",
        windows: "1h",
        mode: .metricsOnly,
        codexAccount: true
      ),
      isolatedConfigURL: URL(fileURLWithPath: "/tmp/isolated.json"),
      codexExecutable: URL(fileURLWithPath: "/tmp/codex"),
      claudeExecutable: URL(fileURLWithPath: "/tmp/claude")
    )

    XCTAssertTrue(
      containsOption(
        arguments,
        "--providers",
        "claude,gemini,copilot,qwen"
      )
    )
    XCTAssertTrue(containsOption(arguments, "--otel-port", "4318"))
    XCTAssertTrue(arguments.contains("--no-backfill"))
    XCTAssertTrue(arguments.contains("--no-codex-account"))
    XCTAssertTrue(arguments.contains("--no-claude-account"))
    XCTAssertTrue(arguments.contains("--offline"))
    XCTAssertFalse(arguments.contains("--codex-account"))
    XCTAssertFalse(arguments.contains("/tmp/codex"))
    XCTAssertFalse(arguments.contains("/tmp/claude"))
  }

  func testStandardModeCanReceiveSupportedCLIMetrics() {
    let arguments = SidecarLaunchPolicy.arguments(
      for: SidecarConfiguration(
        cliPath: "",
        windows: "1h",
        mode: .standard,
        codexAccount: false,
        otelMetrics: true
      ),
      isolatedConfigURL: URL(fileURLWithPath: "/tmp/isolated.json"),
      codexExecutable: nil,
      claudeExecutable: nil
    )

    XCTAssertTrue(
      containsOption(
        arguments,
        "--providers",
        "codex,claude,gemini,copilot,qwen"
      )
    )
    XCTAssertTrue(containsOption(arguments, "--otel-port", "4318"))
    XCTAssertFalse(arguments.contains("--no-backfill"))
  }

  func testLocalRuntimeEndpointsAddOnlyTheirProviders() {
    let arguments = SidecarLaunchPolicy.arguments(
      for: SidecarConfiguration(
        cliPath: "",
        windows: "1h",
        mode: .standard,
        codexAccount: false,
        llamaCppMetricsURL: "http://127.0.0.1:8080/metrics",
        vllmMetricsURL: "http://127.0.0.1:8000/metrics"
      ),
      isolatedConfigURL: URL(fileURLWithPath: "/tmp/isolated.json"),
      codexExecutable: nil,
      claudeExecutable: nil
    )

    XCTAssertTrue(
      containsOption(
        arguments,
        "--providers",
        "codex,claude,llamacpp,vllm"
      )
    )
    XCTAssertTrue(
      containsOption(
        arguments,
        "--llamacpp-metrics",
        "http://127.0.0.1:8080/metrics"
      )
    )
    XCTAssertTrue(
      containsOption(
        arguments,
        "--vllm-metrics",
        "http://127.0.0.1:8000/metrics"
      )
    )
  }

  func testLocalMetricsURLsStayOnLoopbackHTTP() {
    XCTAssertEqual(
      normalizedLocalMetricsURL(" http://localhost:8080/metrics "),
      "http://localhost:8080/metrics"
    )
    XCTAssertEqual(normalizedLocalMetricsURL(""), "")
    XCTAssertNil(
      normalizedLocalMetricsURL("https://127.0.0.1:8080/metrics")
    )
    XCTAssertNil(
      normalizedLocalMetricsURL("http://example.com/metrics")
    )
    XCTAssertNil(
      normalizedLocalMetricsURL(
        "http://user:password@127.0.0.1:8080/metrics"
      )
    )
  }

  func testChildEnvironmentRemovesConfigurationAndInjectionVariables() {
    let environment = SidecarLaunchPolicy.sanitizedEnvironment(from: [
      "HOME": "/tmp/home",
      "PATH": "/custom/bin",
      "TALLYBURN_CONFIG": "/tmp/global.json",
      "TALLYBURN_CODEX_ACCOUNT": "1",
      "TALLYBURN_OTEL_LOGS": "1",
      "OTEL_EXPORTER_OTLP_ENDPOINT": "https://example.invalid",
      "ANTHROPIC_API_KEY": "not-forwarded",
      "ANTHROPIC_AUTH_TOKEN": "not-forwarded",
      "CLAUDE_CODE_OAUTH_TOKEN": "not-forwarded",
      "NODE_OPTIONS": "--require=/tmp/inject.js",
      "NODE_PATH": "/tmp/modules",
    ])

    XCTAssertEqual(environment["HOME"], "/tmp/home")
    XCTAssertNil(environment["TALLYBURN_CONFIG"])
    XCTAssertNil(environment["TALLYBURN_CODEX_ACCOUNT"])
    XCTAssertNil(environment["TALLYBURN_OTEL_LOGS"])
    XCTAssertNil(environment["OTEL_EXPORTER_OTLP_ENDPOINT"])
    XCTAssertNil(environment["ANTHROPIC_API_KEY"])
    XCTAssertNil(environment["ANTHROPIC_AUTH_TOKEN"])
    XCTAssertNil(environment["CLAUDE_CODE_OAUTH_TOKEN"])
    XCTAssertNil(environment["NODE_OPTIONS"])
    XCTAssertNil(environment["NODE_PATH"])
    XCTAssertTrue(environment["PATH"]?.contains("/custom/bin") == true)
  }

  private func containsOption(
    _ arguments: [String],
    _ option: String,
    _ value: String
  ) -> Bool {
    arguments.indices.contains { index in
      arguments[index] == option
        && arguments.indices.contains(index + 1)
        && arguments[index + 1] == value
    }
  }
}

final class RollingWindowConfigurationTests: XCTestCase {
  func testNormalizesValidWindows() {
    XCTAssertEqual(
      RollingWindowConfiguration.normalize(" 30M, 1h,12H "),
      "30m,1h,12h"
    )
  }

  func testRejectsInvalidDuplicateAndExcessiveWindows() {
    XCTAssertNil(RollingWindowConfiguration.normalize(""))
    XCTAssertNil(RollingWindowConfiguration.normalize("1h,60m"))
    XCTAssertNil(RollingWindowConfiguration.normalize("31d"))
    XCTAssertNil(
      RollingWindowConfiguration.normalize(
        "1m,2m,3m,4m,5m,6m,7m"
      )
    )
  }
}

@MainActor
final class DashboardLayoutTests: XCTestCase {
  func testMenuBarDashboardHasAStableCompactLoadingHeight() {
    let suiteName = "TallyburnTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defaults.removePersistentDomain(forName: suiteName)
    defaults.set(true, forKey: "monitoringConsent")
    defer { defaults.removePersistentDomain(forName: suiteName) }

    let model = AppModel(
      defaults: defaults,
      client: FakeSidecarClient(),
      automaticallyStartsMonitoring: false,
      reconnectDelays: [],
      terminateApplication: {}
    )
    let hostingView = NSHostingView(
      rootView: DashboardView(model: model)
    )

    hostingView.layoutSubtreeIfNeeded()

    XCTAssertEqual(hostingView.fittingSize.width, 390, accuracy: 1)
    XCTAssertEqual(
      hostingView.fittingSize.height,
      420,
      accuracy: 1,
      "The loading panel needs an explicit compact height because ScrollView has no useful intrinsic height."
    )
  }

  func testMenuBarDashboardUsesTheSelectedModesStableHeight() {
    let suiteName = "TallyburnTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defaults.removePersistentDomain(forName: suiteName)
    defaults.set(true, forKey: "monitoringConsent")
    defer { defaults.removePersistentDomain(forName: suiteName) }

    let client = FakeSidecarClient()
    let model = AppModel(
      defaults: defaults,
      client: client,
      reconnectDelays: [],
      terminateApplication: {}
    )
    let aggregate = ProviderAggregateDTO(
      provider: "all",
      observations: 0,
      freshInput: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      total: 0,
      lastEventAt: nil
    )
    client.sendState(.connected)
    client.sendEnvelope(
      SnapshotEnvelope(
        schemaVersion: 1,
        type: "snapshot",
        sequence: 1,
        snapshot: UsageSnapshotDTO(
          generatedAt: 0,
          windows: [
            WindowAggregateDTO(
              label: "1h",
              durationMs: 3_600_000,
              all: aggregate,
              providers: [:]
            )
          ],
          focusWindow: "1h",
          recentTokensPerMinute: 0,
          recentRateWindowMs: nil,
          liveRate: nil,
          liveActivity: nil,
          series: [:],
          seriesByWindow: nil,
          quotas: [:],
          accounts: nil,
          sources: [:]
        )
      )
    )

    for mode in DashboardMode.allCases {
      let hostingView = NSHostingView(
        rootView: DashboardView(model: model, initialMode: mode)
      )
      hostingView.layoutSubtreeIfNeeded()

      XCTAssertEqual(
        hostingView.fittingSize.height,
        mode.panelHeight,
        accuracy: 1,
        "\(mode.rawValue) must retain its height across snapshot refreshes."
      )
    }
  }

  func testMiniMonitorUsesItsCompactStableSize() {
    let suiteName = "TallyburnTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defaults.removePersistentDomain(forName: suiteName)
    defaults.set(true, forKey: "monitoringConsent")
    defaults.set(true, forKey: "miniMonitorEnabled")
    defer { defaults.removePersistentDomain(forName: suiteName) }

    let client = FakeSidecarClient()
    let model = AppModel(
      defaults: defaults,
      client: client,
      reconnectDelays: [],
      terminateApplication: {}
    )
    let aggregate = ProviderAggregateDTO(
      provider: "all",
      observations: 0,
      freshInput: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      total: 0,
      lastEventAt: nil
    )
    client.sendState(.connected)
    client.sendEnvelope(
      SnapshotEnvelope(
        schemaVersion: 1,
        type: "snapshot",
        sequence: 1,
        snapshot: UsageSnapshotDTO(
          generatedAt: 0,
          windows: [
            WindowAggregateDTO(
              label: "1h",
              durationMs: 3_600_000,
              all: aggregate,
              providers: [:]
            )
          ],
          focusWindow: "1h",
          recentTokensPerMinute: 0,
          recentRateWindowMs: 60_000,
          liveRate: nil,
          liveActivity: nil,
          series: [:],
          seriesByWindow: nil,
          quotas: [:],
          accounts: nil,
          sources: [:]
        )
      )
    )

    let hostingView = NSHostingView(
      rootView: DashboardView(model: model)
    )
    hostingView.layoutSubtreeIfNeeded()

    XCTAssertEqual(hostingView.fittingSize.width, 320, accuracy: 1)
    XCTAssertEqual(hostingView.fittingSize.height, 300, accuracy: 1)
  }

  func testIdleLiveDashboardCanBeRenderedForVisualReview() throws {
    let suiteName = "TallyburnTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defaults.removePersistentDomain(forName: suiteName)
    defaults.set(true, forKey: "monitoringConsent")
    defer { defaults.removePersistentDomain(forName: suiteName) }

    let client = FakeSidecarClient()
    let model = AppModel(
      defaults: defaults,
      client: client,
      reconnectDelays: [],
      terminateApplication: {}
    )
    let generatedAt = Date().timeIntervalSince1970 * 1_000
    let aggregate = ProviderAggregateDTO(
      provider: "all",
      observations: 0,
      freshInput: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      total: 0,
      lastEventAt: nil
    )
    let buckets = (0..<60).map {
      BucketPointDTO(
        start: generatedAt - Double(59 - $0) * 1_000,
        tokens: 0
      )
    }
    let rates = (0..<60).map {
      ActivityRatePointDTO(
        at: generatedAt - Double(59 - $0) * 1_000,
        tokensPerSecond: 0
      )
    }

    client.sendState(.connected)
    client.sendEnvelope(
      SnapshotEnvelope(
        schemaVersion: 1,
        type: "snapshot",
        sequence: 1,
        snapshot: UsageSnapshotDTO(
          generatedAt: generatedAt,
          windows: [
            WindowAggregateDTO(
              label: "1h",
              durationMs: 3_600_000,
              all: aggregate,
              providers: [:]
            )
          ],
          focusWindow: "1h",
          recentTokensPerMinute: 0,
          recentRateWindowMs: 60_000,
          liveRate: nil,
          liveActivity: LiveActivityDTO(
            historyWindowMs: 60_000,
            sampleIntervalMs: 1_000,
            rateWindowMs: 60_000,
            all: ProviderActivityDTO(
              provider: "all",
              observedTokens: 0,
              tokensPerSecond: 0,
              observations: 0,
              lastEventAt: nil
            ),
            providers: [:],
            series: ["all": buckets],
            rateSeries: ["all": rates]
          ),
          series: ["all": buckets],
          seriesByWindow: nil,
          quotas: [:],
          accounts: nil,
          sources: [:]
        )
      )
    )

    let hostingView = NSHostingView(
      rootView:
        DashboardView(model: model)
        .environment(\.locale, Locale(identifier: "ko"))
        .environment(\.colorScheme, .dark)
        .background(Color(nsColor: .windowBackgroundColor))
    )
    hostingView.appearance = NSAppearance(named: .darkAqua)
    hostingView.frame = NSRect(
      x: 0,
      y: 0,
      width: 390,
      height: DashboardMode.now.panelHeight
    )
    hostingView.layoutSubtreeIfNeeded()

    XCTAssertEqual(hostingView.fittingSize.width, 390, accuracy: 1)
    XCTAssertEqual(
      hostingView.fittingSize.height,
      DashboardMode.now.panelHeight,
      accuracy: 1
    )

    try writeVisualReview(
      hostingView,
      environmentKey: "TALLYBURN_IDLE_VISUAL_REVIEW_OUTPUT"
    )
  }

  func testShowcaseDashboardCanBeRenderedForVisualReview() throws {
    let suiteName = "TallyburnTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defaults.removePersistentDomain(forName: suiteName)
    defaults.set(true, forKey: "monitoringConsent")
    defer { defaults.removePersistentDomain(forName: suiteName) }

    let client = FakeSidecarClient()
    let model = AppModel(
      defaults: defaults,
      client: client,
      reconnectDelays: [],
      terminateApplication: {}
    )
    let generatedAt = Date().timeIntervalSince1970 * 1_000
    let activityRates = (0..<60).map { index in
      let phase = Double(index) / 59
      return 14_800
        + 1_700 * sin(phase * .pi * 2)
        + 650 * sin(phase * .pi * 6)
    }
    let allBuckets = activityRates.enumerated().map {
      BucketPointDTO(
        start: generatedAt - Double(59 - $0.offset) * 1_000,
        tokens: Int64($0.element.rounded())
      )
    }
    let allRatePoints = activityRates.enumerated().map {
      ActivityRatePointDTO(
        at: generatedAt - Double(59 - $0.offset) * 1_000,
        tokensPerSecond: $0.element
      )
    }
    let providerBuckets: (Int, Int64, Int, Int64) -> [BucketPointDTO] = {
      firstIndex, firstTokens, secondIndex, secondTokens in
      (0..<60).map { index in
        BucketPointDTO(
          start: generatedAt - Double(59 - index) * 1_000,
          tokens:
            index == firstIndex
            ? firstTokens
            : index == secondIndex ? secondTokens : 0
        )
      }
    }
    let allAggregate = ProviderAggregateDTO(
      provider: "all",
      observations: 42,
      freshInput: 947_000,
      cacheRead: 1_607_000,
      cacheWrite: 0,
      output: 316_000,
      reasoning: 57_000,
      total: 2_870_000,
      lastEventAt: generatedAt - 1_000
    )
    let providerAggregate: (String, Int64, Int64, Int64) -> ProviderAggregateDTO =
      { provider, context, cache, output in
        ProviderAggregateDTO(
          provider: provider,
          observations: 14,
          freshInput: context,
          cacheRead: cache,
          cacheWrite: 0,
          output: output,
          reasoning: output / 6,
          total: context + cache + output,
          lastEventAt: generatedAt - 1_000
        )
      }
    let providers = [
      "codex": providerAggregate("codex", 340_000, 570_000, 110_000),
      "claude": providerAggregate("claude", 310_000, 520_000, 100_000),
      "qwen": providerAggregate("qwen", 297_000, 517_000, 106_000),
    ]

    client.sendState(.connected)
    client.sendEnvelope(
      SnapshotEnvelope(
        schemaVersion: 1,
        type: "snapshot",
        sequence: 1,
        snapshot: UsageSnapshotDTO(
          generatedAt: generatedAt,
          windows: [
            WindowAggregateDTO(
              label: "1h",
              durationMs: 3_600_000,
              all: allAggregate,
              providers: providers
            )
          ],
          focusWindow: "1h",
          recentTokensPerMinute: 972_000,
          recentRateWindowMs: 60_000,
          liveRate: nil,
          liveActivity: LiveActivityDTO(
            historyWindowMs: 60_000,
            sampleIntervalMs: 1_000,
            rateWindowMs: 60_000,
            all: ProviderActivityDTO(
              provider: "all",
              observedTokens: 972_000,
              tokensPerSecond: 16_200,
              observations: 6,
              lastEventAt: generatedAt - 1_000
            ),
            providers: [
              "codex": ProviderActivityDTO(
                provider: "codex",
                observedTokens: 348_000,
                tokensPerSecond: 5_800,
                observations: 2,
                lastEventAt: generatedAt - 1_000
              ),
              "claude": ProviderActivityDTO(
                provider: "claude",
                observedTokens: 312_000,
                tokensPerSecond: 5_200,
                observations: 2,
                lastEventAt: generatedAt - 2_000
              ),
              "qwen": ProviderActivityDTO(
                provider: "qwen",
                observedTokens: 312_000,
                tokensPerSecond: 5_200,
                observations: 2,
                lastEventAt: generatedAt - 3_000
              ),
            ],
            series: [
              "all": allBuckets,
              "codex": providerBuckets(14, 12_000, 46, 15_000),
              "claude": providerBuckets(22, 11_000, 50, 13_000),
              "qwen": providerBuckets(31, 12_500, 56, 14_000),
            ],
            rateSeries: ["all": allRatePoints]
          ),
          series: ["all": allBuckets],
          seriesByWindow: nil,
          quotas: [
            "codex": QuotaSnapshotDTO(
              provider: "codex",
              timestamp: generatedAt,
              planType: nil,
              primary: QuotaWindowDTO(
                usedPercent: 61,
                windowMs: 7 * 24 * 3_600_000,
                resetsAt: generatedAt + 3 * 24 * 3_600_000
              ),
              secondary: nil
            )
          ],
          accounts: nil,
          sources: [:]
        )
      )
    )

    let hostingView = NSHostingView(
      rootView:
        DashboardView(model: model)
        .environment(\.locale, Locale(identifier: "en"))
        .environment(\.colorScheme, .dark)
        .background(Color(nsColor: .windowBackgroundColor))
    )
    hostingView.appearance = NSAppearance(named: .darkAqua)
    hostingView.frame = NSRect(
      x: 0,
      y: 0,
      width: 390,
      height: DashboardMode.now.panelHeight
    )
    hostingView.layoutSubtreeIfNeeded()
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.1))
    hostingView.layoutSubtreeIfNeeded()
    hostingView.displayIfNeeded()

    XCTAssertEqual(hostingView.fittingSize.width, 390, accuracy: 1)
    XCTAssertEqual(
      hostingView.fittingSize.height,
      DashboardMode.now.panelHeight,
      accuracy: 1
    )
    try writeVisualReview(
      hostingView,
      environmentKey: "TALLYBURN_DASHBOARD_SHOWCASE_OUTPUT"
    )

    model.setMiniMonitorEnabled(true)
    let miniHostingView = NSHostingView(
      rootView:
        DashboardView(model: model)
        .environment(\.locale, Locale(identifier: "en"))
        .environment(\.colorScheme, .dark)
        .background(Color(nsColor: .windowBackgroundColor))
    )
    miniHostingView.appearance = NSAppearance(named: .darkAqua)
    miniHostingView.frame = NSRect(
      x: 0,
      y: 0,
      width: 320,
      height: 300
    )
    miniHostingView.layoutSubtreeIfNeeded()
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.1))
    miniHostingView.layoutSubtreeIfNeeded()
    miniHostingView.displayIfNeeded()

    XCTAssertEqual(miniHostingView.fittingSize.width, 320, accuracy: 1)
    XCTAssertEqual(miniHostingView.fittingSize.height, 300, accuracy: 1)
    try writeVisualReview(
      miniHostingView,
      environmentKey: "TALLYBURN_MINI_VISUAL_REVIEW_OUTPUT"
    )
  }

  private func writeVisualReview(
    _ hostingView: NSView,
    environmentKey: String
  ) throws {
    guard
      let output = ProcessInfo.processInfo.environment[environmentKey]
    else {
      return
    }
    let representation = try XCTUnwrap(
      hostingView.bitmapImageRepForCachingDisplay(in: hostingView.bounds)
    )
    hostingView.cacheDisplay(
      in: hostingView.bounds,
      to: representation
    )
    let data = try XCTUnwrap(
      representation.representation(using: .png, properties: [:])
    )
    try data.write(to: URL(fileURLWithPath: output), options: .atomic)
  }
}

@MainActor
final class SettingsLayoutTests: XCTestCase {
  func testSettingsUseNativeColorPickersWithoutClipping() throws {
    let suiteName = "TallyburnTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defaults.removePersistentDomain(forName: suiteName)
    defaults.set(
      [
        "codex": "#FF2D55",
        "claude": "#64D2FF",
      ],
      forKey: "providerColors"
    )
    defer { defaults.removePersistentDomain(forName: suiteName) }

    let model = AppModel(
      defaults: defaults,
      client: FakeSidecarClient(),
      automaticallyStartsMonitoring: false,
      reconnectDelays: [],
      terminateApplication: {}
    )
    let hostingView = NSHostingView(
      rootView:
        SettingsView(model: model)
        .environment(\.locale, Locale(identifier: "ko"))
        .environment(\.colorScheme, .dark)
    )
    hostingView.frame = NSRect(x: 0, y: 0, width: 520, height: 620)
    hostingView.layoutSubtreeIfNeeded()

    XCTAssertEqual(hostingView.fittingSize.width, 520, accuracy: 1)
    XCTAssertGreaterThanOrEqual(hostingView.fittingSize.height, 620)

    guard
      let output = ProcessInfo.processInfo.environment[
        "TALLYBURN_VISUAL_REVIEW_OUTPUT"
      ]
    else {
      return
    }
    let representation = try XCTUnwrap(
      hostingView.bitmapImageRepForCachingDisplay(in: hostingView.bounds)
    )
    hostingView.cacheDisplay(
      in: hostingView.bounds,
      to: representation
    )
    let data = try XCTUnwrap(
      representation.representation(using: .png, properties: [:])
    )
    try data.write(to: URL(fileURLWithPath: output), options: .atomic)
  }
}

@MainActor
final class AppModelLifecycleTests: XCTestCase {
  func testTestHostCanDisableAutomaticMonitoring() {
    let (defaults, suiteName) = makeDefaults(consent: true)
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let client = FakeSidecarClient()

    _ = AppModel(
      defaults: defaults,
      client: client,
      automaticallyStartsMonitoring: false,
      reconnectDelays: [],
      terminateApplication: {}
    )

    XCTAssertEqual(client.startCount, 0)
  }

  func testConnectedStateCancelsPendingReconnect() async throws {
    let (defaults, suiteName) = makeDefaults(consent: true)
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let client = FakeSidecarClient()
    let model = AppModel(
      defaults: defaults,
      client: client,
      reconnectDelays: [.milliseconds(40)],
      terminateApplication: {}
    )
    XCTAssertEqual(client.startCount, 1)

    client.sendState(.failed("temporary"))
    client.sendState(.connected)
    try await Task.sleep(for: .milliseconds(100))

    XCTAssertEqual(model.state, .connected)
    XCTAssertEqual(client.startCount, 1)
  }

  func testRepeatedFailuresCreateOnlyOneReconnectTimer() async throws {
    let (defaults, suiteName) = makeDefaults(consent: true)
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let client = FakeSidecarClient()
    let model = AppModel(
      defaults: defaults,
      client: client,
      reconnectDelays: [.milliseconds(30)],
      terminateApplication: {}
    )

    client.sendState(.failed("first"))
    client.sendState(.failed("duplicate"))
    try await Task.sleep(for: .milliseconds(80))

    XCTAssertEqual(client.startCount, 2)
    _ = model
  }

  func testQuitWaitsForHelperStopCompletion() {
    let (defaults, suiteName) = makeDefaults(consent: true)
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let client = FakeSidecarClient()
    var didTerminate = false
    let model = AppModel(
      defaults: defaults,
      client: client,
      reconnectDelays: [],
      terminateApplication: {
        didTerminate = true
      }
    )

    model.quit()
    XCTAssertFalse(didTerminate)
    XCTAssertEqual(client.stopCount, 1)

    client.completeStop()
    XCTAssertTrue(didTerminate)
  }

  func testInvalidSettingsDoNotRestartOrGrantConsent() {
    let (defaults, suiteName) = makeDefaults(consent: false)
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let client = FakeSidecarClient()
    let model = AppModel(
      defaults: defaults,
      client: client,
      reconnectDelays: [],
      terminateApplication: {}
    )

    let didApply = model.applySettings(
      mode: .standard,
      windows: "1h,60m",
      codexAccount: true,
      cliPath: ""
    )

    XCTAssertFalse(didApply)
    XCTAssertFalse(model.hasMonitoringConsent)
    XCTAssertNotNil(model.settingsError)
    XCTAssertEqual(client.startCount, 0)
  }

  func testValidSettingsApplyTogetherAndRestartOnce() {
    let (defaults, suiteName) = makeDefaults(consent: false)
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let client = FakeSidecarClient()
    let model = AppModel(
      defaults: defaults,
      client: client,
      reconnectDelays: [],
      terminateApplication: {}
    )

    let didApply = model.applySettings(
      mode: .metricsOnly,
      windows: " 30M, 1h,12H ",
      codexAccount: true,
      otelMetrics: true,
      cliPath: ""
    )

    XCTAssertTrue(didApply)
    XCTAssertTrue(model.hasMonitoringConsent)
    XCTAssertEqual(model.mode, .metricsOnly)
    XCTAssertEqual(model.windows, "30m,1h,12h")
    XCTAssertTrue(model.codexAccount)
    XCTAssertTrue(model.otelMetrics)
    XCTAssertNil(model.settingsError)
    XCTAssertEqual(client.startCount, 1)
    XCTAssertEqual(
      defaults.string(forKey: "monitoringMode"),
      MonitoringMode.metricsOnly.rawValue
    )
    XCTAssertEqual(
      defaults.string(forKey: "windows"),
      "30m,1h,12h"
    )
    XCTAssertTrue(defaults.bool(forKey: "otelMetrics"))
  }

  func testUnchangedMonitoringSettingsDoNotRestart() {
    let (defaults, suiteName) = makeDefaults(consent: true)
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let client = FakeSidecarClient()
    let model = AppModel(
      defaults: defaults,
      client: client,
      reconnectDelays: [],
      terminateApplication: {}
    )

    XCTAssertEqual(client.startCount, 1)

    let didApply = model.applySettings(
      mode: .standard,
      windows: "1h,3h,12h",
      codexAccount: false,
      cliPath: ""
    )

    XCTAssertTrue(didApply)
    XCTAssertEqual(client.startCount, 1)
  }

  func testManualRestartRestoresReconnectBudget() async throws {
    let (defaults, suiteName) = makeDefaults(consent: true)
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let client = FakeSidecarClient()
    let model = AppModel(
      defaults: defaults,
      client: client,
      reconnectDelays: [.milliseconds(20)],
      terminateApplication: {}
    )

    client.sendState(.failed("first"))
    try await Task.sleep(for: .milliseconds(60))
    XCTAssertEqual(client.startCount, 2)

    client.sendState(.failed("budget exhausted"))
    try await Task.sleep(for: .milliseconds(40))
    XCTAssertEqual(client.startCount, 2)

    model.restart()
    XCTAssertEqual(client.startCount, 3)

    client.sendState(.failed("after manual retry"))
    try await Task.sleep(for: .milliseconds(60))
    XCTAssertEqual(client.startCount, 4)
  }

  func testMenuPresentationPrefersTrailingLiveRate() {
    let (defaults, suiteName) = makeDefaults(consent: true)
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let client = FakeSidecarClient()
    let model = AppModel(
      defaults: defaults,
      client: client,
      reconnectDelays: [],
      terminateApplication: {}
    )

    client.sendEnvelope(
      makeEnvelope(
        recentTokensPerMinute: 90,
        liveRate: LiveRateDTO(
          trailingWindowMs: 60_000,
          all: makeRate(
            provider: "all",
            tokensPerMinute: 1_200,
            lastEventAt: 1_900
          ),
          providers: [
            "codex": makeRate(
              provider: "codex",
              tokensPerMinute: 800,
              lastEventAt: 1_900
            ),
            "claude": makeRate(
              provider: "claude",
              tokensPerMinute: 400,
              lastEventAt: 1_800
            ),
          ]
        )
      )
    )
    client.sendState(.connected)

    XCTAssertEqual(model.observedPace, 1_200)
    XCTAssertEqual(model.recentPace, 90)
    XCTAssertEqual(model.menuAverageTokensPerSecond, 20)
    XCTAssertEqual(
      model.menuTitle,
      localizedFormat("unit.perSecond.compact", fallback: "%@/s", "20")
    )
    XCTAssertEqual(model.menuIcon, "flame.fill")
    XCTAssertEqual(
      model.observedPaceCaption,
      localizedFormat(
        "observedPace.caption.trailing",
        fallback: "last %@ · updates every 1s",
        "1m"
      )
    )
    XCTAssertEqual(
      model.observedPaceHelp,
      localizedFormat(
        "observedPace.help.trailing",
        fallback:
          "Raw tokens reported by completed responses and telemetry during the trailing %@.",
        localizedFormat(
          "rateWindow.minute.one",
          fallback: "%d minute",
          1
        )
      )
        + localized(
          "observedPace.help.limitation",
          fallback:
            " This is not in-flight generation speed or plan quota."
        )
    )
    XCTAssertEqual(model.observedPace(for: "codex"), 800)
    XCTAssertEqual(model.lastObservedEventAt, 1_900)
    let trailingMinute = localizedFormat(
      "rateWindow.minute.one",
      fallback: "%d minute",
      1
    )
    let paceBasis = localizedFormat(
      "accessibility.paceBasis.trailing",
      fallback: "over the last %@",
      trailingMinute
    )
    XCTAssertTrue(
      model.accessibilityLabel.contains(
        localizedFormat(
          "accessibility.monitor.pace",
          fallback:
            "Observed token pace %lld tokens per minute %@ from reported responses",
          Int64(1_200),
          paceBasis
        )
      )
    )
    XCTAssertTrue(
      model.accessibilityLabel.contains(
        localizedFormat(
          "accessibility.monitor.total",
          fallback: ". %@ total %lld tokens",
          "1h",
          Int64(1_000)
        )
      )
    )
  }

  func testMenuBarAppearancePreferencesDefaultOffAndPersist() {
    let (defaults, suiteName) = makeDefaults(consent: true)
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let model = AppModel(
      defaults: defaults,
      client: FakeSidecarClient(),
      automaticallyStartsMonitoring: false,
      reconnectDelays: [],
      terminateApplication: {}
    )

    XCTAssertFalse(model.showRateInMenuBar)
    XCTAssertFalse(model.miniMonitorEnabled)

    model.setShowRateInMenuBar(true)
    model.setMiniMonitorEnabled(true)

    XCTAssertTrue(model.showRateInMenuBar)
    XCTAssertTrue(model.miniMonitorEnabled)
    XCTAssertTrue(defaults.bool(forKey: "showRateInMenuBar"))
    XCTAssertTrue(defaults.bool(forKey: "miniMonitorEnabled"))

    let restoredModel = AppModel(
      defaults: defaults,
      client: FakeSidecarClient(),
      automaticallyStartsMonitoring: false,
      reconnectDelays: [],
      terminateApplication: {}
    )
    XCTAssertTrue(restoredModel.showRateInMenuBar)
    XCTAssertTrue(restoredModel.miniMonitorEnabled)
  }

  func testProviderColorOverridesAreSanitizedAndPersisted() {
    let (defaults, suiteName) = makeDefaults(consent: true)
    defer { defaults.removePersistentDomain(forName: suiteName) }
    defaults.set(
      [
        " CODEX ": "123456",
        "bad provider": "#ABCDEF",
        "claude": "not-a-color",
      ],
      forKey: "providerColors"
    )
    let model = AppModel(
      defaults: defaults,
      client: FakeSidecarClient(),
      automaticallyStartsMonitoring: false,
      reconnectDelays: [],
      terminateApplication: {}
    )

    XCTAssertEqual(model.providerColors, ["codex": "#123456"])

    model.setProviderColors([
      "QWEN": "#a1b2c3",
      "invalid provider": "#FFFFFF",
    ])

    XCTAssertEqual(model.providerColors, ["qwen": "#A1B2C3"])
    let restored = AppModel(
      defaults: defaults,
      client: FakeSidecarClient(),
      automaticallyStartsMonitoring: false,
      reconnectDelays: [],
      terminateApplication: {}
    )
    XCTAssertEqual(restored.providerColors, ["qwen": "#A1B2C3"])
  }

  func testConfigurableProvidersIncludeAllSupportedSources() {
    let (defaults, suiteName) = makeDefaults(consent: true)
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let client = FakeSidecarClient()
    let model = AppModel(
      defaults: defaults,
      client: client,
      automaticallyStartsMonitoring: false,
      reconnectDelays: [],
      terminateApplication: {}
    )
    model.start()
    let aggregate = ProviderAggregateDTO(
      provider: "qwen",
      observations: 1,
      freshInput: 10,
      cacheRead: 0,
      cacheWrite: 0,
      output: 5,
      reasoning: 0,
      total: 15,
      lastEventAt: 1_000
    )
    client.sendEnvelope(
      SnapshotEnvelope(
        schemaVersion: 1,
        type: "snapshot",
        sequence: 1,
        snapshot: UsageSnapshotDTO(
          generatedAt: 1_000,
          windows: [
            WindowAggregateDTO(
              label: "1h",
              durationMs: 3_600_000,
              all: aggregate,
              providers: ["qwen": aggregate]
            )
          ],
          focusWindow: "1h",
          recentTokensPerMinute: 15,
          recentRateWindowMs: nil,
          liveRate: nil,
          liveActivity: nil,
          series: [:],
          seriesByWindow: nil,
          quotas: [:],
          accounts: nil,
          sources: [:]
        )
      )
    )

    XCTAssertEqual(
      model.configurableProviders,
      [
        "codex", "claude", "gemini", "copilot", "qwen", "llamacpp", "vllm",
      ]
    )
  }

  func testConfigurableProvidersCanBeColoredBeforeObservation() {
    let (defaults, suiteName) = makeDefaults(consent: true)
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let client = FakeSidecarClient()
    let model = AppModel(
      defaults: defaults,
      client: client,
      automaticallyStartsMonitoring: false,
      reconnectDelays: [],
      terminateApplication: {}
    )
    model.start()
    let zero = ProviderAggregateDTO(
      provider: "qwen",
      observations: 0,
      freshInput: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      total: 0,
      lastEventAt: nil
    )
    client.sendEnvelope(
      SnapshotEnvelope(
        schemaVersion: 1,
        type: "snapshot",
        sequence: 1,
        snapshot: UsageSnapshotDTO(
          generatedAt: 1_000,
          windows: [
            WindowAggregateDTO(
              label: "1h",
              durationMs: 3_600_000,
              all: zero,
              providers: ["qwen": zero]
            )
          ],
          focusWindow: "1h",
          recentTokensPerMinute: 0,
          recentRateWindowMs: nil,
          liveRate: nil,
          liveActivity: nil,
          series: [:],
          seriesByWindow: nil,
          quotas: [:],
          accounts: nil,
          sources: [
            "qwen": SourceStatusDTO(
              provider: "qwen",
              available: false,
              filesSeen: 0,
              filesRead: 0,
              malformedLines: 0,
              lastEventAt: nil
            )
          ]
        )
      )
    )

    XCTAssertEqual(
      model.configurableProviders,
      [
        "codex", "claude", "gemini", "copilot", "qwen", "llamacpp", "vllm",
      ]
    )
  }

  func testMenuPresentationPrefersOneMinuteLiveActivity() {
    let (defaults, suiteName) = makeDefaults(consent: true)
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let client = FakeSidecarClient()
    let model = AppModel(
      defaults: defaults,
      client: client,
      reconnectDelays: [],
      terminateApplication: {}
    )

    client.sendEnvelope(
      makeEnvelope(
        recentTokensPerMinute: 90,
        liveRate: LiveRateDTO(
          trailingWindowMs: 60_000,
          all: makeRate(
            provider: "all",
            tokensPerMinute: 1_200,
            lastEventAt: 1_900
          ),
          providers: [
            "codex": makeRate(
              provider: "codex",
              tokensPerMinute: 800,
              lastEventAt: 1_900
            ),
            "claude": makeRate(
              provider: "claude",
              tokensPerMinute: 400,
              lastEventAt: 1_800
            ),
          ]
        ),
        liveActivity: makeActivity()
      )
    )
    client.sendState(.connected)

    XCTAssertEqual(model.currentReportedTokensPerSecond, 20)
    XCTAssertEqual(
      model.reportedTokensPerSecond(for: "codex"),
      800.0 / 60.0
    )
    XCTAssertEqual(
      model.menuTitle,
      localizedFormat("unit.perSecond.compact", fallback: "%@/s", "20")
    )
    XCTAssertEqual(model.menuIcon, "flame.fill")
    XCTAssertEqual(
      model.liveActivityCaption,
      localizedFormat(
        "liveActivity.caption.movingRate",
        fallback: "%@ moving rate · %@ refresh",
        "1m",
        "1s"
      )
    )
    XCTAssertTrue(
      model.liveActivityHelp.contains(
        localized(
          "liveActivity.help.reporting",
          fallback:
            "Providers usually report usage after a response or telemetry batch completes, so this is not in-flight generation speed or plan quota. Zero means no supported client reported a completed response in that trailing window; a response can still be running."
        )
      )
    )
    let liveWindow = localizedFormat(
      "rateWindow.minute.one",
      fallback: "%d minute",
      1
    )
    XCTAssertTrue(
      model.accessibilityLabel.contains(
        localizedFormat(
          "accessibility.monitor.live",
          fallback:
            "Completed-response token activity %@ tokens per second averaged over the last %@",
          "20",
          liveWindow
        )
      )
    )

    client.sendEnvelope(
      makeEnvelope(
        recentTokensPerMinute: 0,
        liveRate: nil,
        liveActivity: makeActivity(
          allTokensPerSecond: 0
        )
      )
    )
    XCTAssertEqual(
      model.liveActivityCaption,
      localizedFormat(
        "liveActivity.caption.noReport",
        fallback: "no completed report · last %@",
        "1m"
      )
    )
    XCTAssertEqual(
      model.menuTitle,
      localizedFormat("unit.perSecond.compact", fallback: "%@/s", "0")
    )
    XCTAssertEqual(model.menuIcon, "flame")

    client.sendEnvelope(
      makeEnvelope(
        recentTokensPerMinute: 0,
        liveRate: nil,
        liveActivity: makeActivity(
          allTokensPerSecond: 0.2
        )
      )
    )
    XCTAssertEqual(
      model.menuTitle,
      localizedFormat("unit.perSecond.compact", fallback: "%@/s", "0.20")
    )
    XCTAssertEqual(model.menuIcon, "flame.fill")
  }

  func testMenuPresentationFallsBackToLegacyFiveMinutePace() {
    let (defaults, suiteName) = makeDefaults(consent: true)
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let client = FakeSidecarClient()
    let model = AppModel(
      defaults: defaults,
      client: client,
      reconnectDelays: [],
      terminateApplication: {}
    )

    client.sendEnvelope(
      makeEnvelope(
        recentTokensPerMinute: 75,
        liveRate: nil
      )
    )
    client.sendState(.connected)

    XCTAssertEqual(model.observedPace, 75)
    XCTAssertEqual(model.menuAverageTokensPerSecond, 1.25)
    XCTAssertEqual(
      model.menuTitle,
      localizedFormat("unit.perSecond.compact", fallback: "%@/s", "1.25")
    )
    XCTAssertEqual(model.menuIcon, "flame.fill")
    XCTAssertEqual(
      model.observedPaceCaption,
      localizedFormat(
        "observedPace.caption.average",
        fallback: "%@ average · updates every 1s",
        "5m"
      )
    )
    let fiveMinutes = localizedFormat(
      "rateWindow.minute.other",
      fallback: "%d minutes",
      5
    )
    XCTAssertEqual(
      model.observedPaceHelp,
      localizedFormat(
        "observedPace.help.legacy",
        fallback:
          "Average raw tokens reported by completed responses and telemetry during the last %@. This older collection engine does not provide the one-minute observed pace.",
        fiveMinutes
      )
        + localized(
          "observedPace.help.limitation",
          fallback:
            " This is not in-flight generation speed or plan quota."
        )
    )
    XCTAssertNil(model.observedPace(for: "codex"))
    XCTAssertEqual(model.lastObservedEventAt, 1_500)
    let averageBasis = localizedFormat(
      "accessibility.paceBasis.average",
      fallback: "averaged over the last %@",
      fiveMinutes
    )
    XCTAssertTrue(
      model.accessibilityLabel.contains(
        localizedFormat(
          "accessibility.monitor.pace",
          fallback:
            "Observed token pace %lld tokens per minute %@ from reported responses",
          Int64(75),
          averageBasis
        )
      )
    )
  }

  func testDisconnectedStatesDoNotPresentRetainedRateAsLive() {
    let (defaults, suiteName) = makeDefaults(consent: true)
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let client = FakeSidecarClient()
    let model = AppModel(
      defaults: defaults,
      client: client,
      reconnectDelays: [],
      terminateApplication: {}
    )
    client.sendEnvelope(
      makeEnvelope(
        recentTokensPerMinute: 90,
        liveRate: LiveRateDTO(
          trailingWindowMs: 60_000,
          all: makeRate(
            provider: "all",
            tokensPerMinute: 1_200,
            lastEventAt: 1_900
          ),
          providers: [
            "codex": makeRate(
              provider: "codex",
              tokensPerMinute: 800,
              lastEventAt: 1_900
            )
          ]
        ),
        liveActivity: makeActivity()
      )
    )

    for (state, availability) in [
      (
        SidecarState.starting,
        localized(
          "availability.reconnecting",
          fallback: "reconnecting"
        )
      ),
      (
        SidecarState.paused,
        localized("availability.paused", fallback: "paused")
      ),
      (
        SidecarState.failed("offline"),
        localized(
          "availability.unavailable",
          fallback: "the connection is unavailable"
        )
      ),
    ] {
      client.sendState(state)
      XCTAssertNil(model.currentObservedPace)
      XCTAssertNil(model.currentReportedTokensPerSecond)
      XCTAssertNil(model.menuAverageTokensPerSecond)
      XCTAssertEqual(
        model.menuTitle,
        localizedFormat("unit.perSecond.compact", fallback: "%@/s", "—")
      )
      let caption = localizedFormat(
        "liveActivity.caption.lastKnown",
        fallback: "last known · %@",
        availability
      )
      XCTAssertEqual(model.observedPaceCaption, caption)
      XCTAssertEqual(model.liveActivityCaption, caption)
      XCTAssertNil(model.observedPace(for: "codex"))
      XCTAssertNil(model.reportedTokensPerSecond(for: "codex"))
      XCTAssertTrue(
        model.accessibilityLabel.contains(
          localizedFormat(
            "accessibility.monitor.unavailable",
            fallback:
              "Tallyburn token activity monitor. Live rate unavailable while %@",
            availability
          )
        )
      )
      XCTAssertFalse(model.accessibilityLabel.contains("1200"))
    }
  }

  private func makeEnvelope(
    recentTokensPerMinute: Int64,
    liveRate: LiveRateDTO?,
    liveActivity: LiveActivityDTO? = nil
  ) -> SnapshotEnvelope {
    let codex = makeAggregate(
      provider: "codex",
      total: 700,
      lastEventAt: 1_500
    )
    let claude = makeAggregate(
      provider: "claude",
      total: 300,
      lastEventAt: 1_400
    )
    let all = makeAggregate(
      provider: "all",
      total: 1_000,
      lastEventAt: 1_500
    )
    return SnapshotEnvelope(
      schemaVersion: 1,
      type: "snapshot",
      sequence: 1,
      snapshot: UsageSnapshotDTO(
        generatedAt: 2_000,
        windows: [
          WindowAggregateDTO(
            label: "1h",
            durationMs: 3_600_000,
            all: all,
            providers: [
              "codex": codex,
              "claude": claude,
            ]
          )
        ],
        focusWindow: "1h",
        recentTokensPerMinute: recentTokensPerMinute,
        recentRateWindowMs: 300_000,
        liveRate: liveRate,
        liveActivity: liveActivity,
        series: [
          "all": [],
          "codex": [],
          "claude": [],
        ],
        seriesByWindow: nil,
        quotas: [:],
        sources: [:]
      )
    )
  }

  private func makeAggregate(
    provider: String,
    total: Int64,
    lastEventAt: Double
  ) -> ProviderAggregateDTO {
    ProviderAggregateDTO(
      provider: provider,
      observations: 1,
      freshInput: total,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      total: total,
      lastEventAt: lastEventAt
    )
  }

  private func makeRate(
    provider: String,
    tokensPerMinute: Int64,
    lastEventAt: Double
  ) -> ProviderRateDTO {
    ProviderRateDTO(
      provider: provider,
      observedTokens: tokensPerMinute,
      tokensPerMinute: tokensPerMinute,
      observations: 1,
      lastEventAt: lastEventAt
    )
  }

  private func makeActivity(
    allTokensPerSecond: Double = 20
  ) -> LiveActivityDTO {
    LiveActivityDTO(
      historyWindowMs: 60_000,
      sampleIntervalMs: 1_000,
      rateWindowMs: 60_000,
      all: ProviderActivityDTO(
        provider: "all",
        observedTokens: 1_200,
        tokensPerSecond: allTokensPerSecond,
        observations: 2,
        lastEventAt: 1_900
      ),
      providers: [
        "codex": ProviderActivityDTO(
          provider: "codex",
          observedTokens: 800,
          tokensPerSecond: 800.0 / 60.0,
          observations: 1,
          lastEventAt: 1_900
        ),
        "claude": ProviderActivityDTO(
          provider: "claude",
          observedTokens: 400,
          tokensPerSecond: 400.0 / 60.0,
          observations: 1,
          lastEventAt: 1_800
        ),
      ],
      series: [
        "all": [
          BucketPointDTO(start: 1_000, tokens: 200),
          BucketPointDTO(start: 2_000, tokens: 301),
        ],
        "codex": [
          BucketPointDTO(start: 1_000, tokens: 0),
          BucketPointDTO(start: 2_000, tokens: 301),
        ],
        "claude": [
          BucketPointDTO(start: 1_000, tokens: 200),
          BucketPointDTO(start: 2_000, tokens: 0),
        ],
      ],
      rateSeries: [
        "all": [
          ActivityRatePointDTO(
            at: 1_000,
            tokensPerSecond: 400.0 / 60.0
          ),
          ActivityRatePointDTO(
            at: 2_000,
            tokensPerSecond: 20
          ),
        ],
        "codex": [
          ActivityRatePointDTO(
            at: 1_000,
            tokensPerSecond: 0
          ),
          ActivityRatePointDTO(
            at: 2_000,
            tokensPerSecond: 800.0 / 60.0
          ),
        ],
        "claude": [
          ActivityRatePointDTO(
            at: 1_000,
            tokensPerSecond: 400.0 / 60.0
          ),
          ActivityRatePointDTO(
            at: 2_000,
            tokensPerSecond: 400.0 / 60.0
          ),
        ],
      ]
    )
  }

  private func makeDefaults(
    consent: Bool
  ) -> (UserDefaults, String) {
    let suiteName = "TallyburnTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defaults.removePersistentDomain(forName: suiteName)
    defaults.set(consent, forKey: "monitoringConsent")
    return (defaults, suiteName)
  }
}

final class SidecarWatchdogTests: XCTestCase {
  func testConfiguredCLIRejectsTheAppExecutable() throws {
    try XCTSkipIf(
      ProcessInfo.processInfo.environment["TALLYBURN_CLI_SCRIPT"] != nil,
      "A development script override takes precedence over cliPath."
    )
    let appExecutable = try XCTUnwrap(Bundle.main.executableURL)
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true
    )
    defer { try? FileManager.default.removeItem(at: directory) }

    let failed = expectation(description: "recursive CLI rejected")
    let client = SidecarClient(
      isolatedConfigURL: directory.appendingPathComponent("config.json")
    )
    client.start(
      configuration: SidecarConfiguration(
        cliPath: appExecutable.path,
        windows: "1h",
        mode: .demo,
        codexAccount: false
      ),
      onEnvelope: { _ in
        XCTFail("The app executable unexpectedly produced a snapshot.")
      },
      onState: { state in
        guard case .failed(let message) = state else { return }
        XCTAssertEqual(
          message,
          localized(
            "sidecar.error.recursiveCLI",
            fallback:
              "The Tallyburn CLI path cannot point to the app executable."
          )
        )
        failed.fulfill()
      }
    )

    wait(for: [failed], timeout: 2)
  }

  func testStartupWatchdogStopsUnresponsiveHelper() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true
    )
    defer { try? FileManager.default.removeItem(at: directory) }

    let helper = directory.appendingPathComponent("unresponsive-helper")
    try """
    #!/usr/bin/perl
    $SIG{TERM} = 'IGNORE';
    sleep 30;
    """.write(to: helper, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o700],
      ofItemAtPath: helper.path
    )

    let failed = expectation(description: "watchdog failure")
    let stopped = expectation(description: "forced helper stop")
    let client = SidecarClient(
      timing: SidecarTiming(
        startupTimeout: 0.05,
        heartbeatTimeout: 1,
        stopGracePeriod: 0.05
      ),
      isolatedConfigURL: directory.appendingPathComponent("config.json")
    )
    client.start(
      configuration: SidecarConfiguration(
        cliPath: helper.path,
        windows: "1h",
        mode: .demo,
        codexAccount: false
      ),
      onEnvelope: { _ in
        XCTFail("Unresponsive helper unexpectedly produced a snapshot.")
      },
      onState: { state in
        guard case .failed(let message) = state else { return }
        XCTAssertEqual(
          message,
          localized(
            "sidecar.error.startupTimeout",
            fallback:
              "Collection engine did not produce data in time."
          )
        )
        failed.fulfill()
        client.stop {
          stopped.fulfill()
        }
      }
    )

    wait(for: [failed, stopped], timeout: 2)
  }

  func testHeartbeatWatchdogStopsHelperAfterSnapshotsCease() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true
    )
    defer { try? FileManager.default.removeItem(at: directory) }

    let helper = directory.appendingPathComponent("stalled-helper")
    let envelope = """
      {"schemaVersion":1,"type":"snapshot","sequence":1,"snapshot":{"generatedAt":1,"windows":[],"focusWindow":"1h","recentTokensPerMinute":0,"series":{},"quotas":{},"sources":{}}}
      """
    try """
    #!/bin/sh
    for sequence in 1 2 3 4
    do
      printf '%s\\n' '\(envelope)'
    done
    exec /usr/bin/perl -e '$SIG{TERM} = "IGNORE"; sleep 30;'
    """.write(to: helper, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o700],
      ofItemAtPath: helper.path
    )

    let connected = expectation(description: "successive snapshots")
    connected.expectedFulfillmentCount = 4
    let failed = expectation(description: "heartbeat failure")
    let stopped = expectation(description: "stalled helper stop")
    let client = SidecarClient(
      timing: SidecarTiming(
        // Full-suite launch contention can exceed one second on CI and
        // developer machines; keep this comfortably above process startup
        // while the heartbeat deadline remains intentionally short.
        startupTimeout: 2,
        heartbeatTimeout: 0.25,
        stopGracePeriod: 0.05
      ),
      isolatedConfigURL: directory.appendingPathComponent("config.json")
    )
    client.start(
      configuration: SidecarConfiguration(
        cliPath: helper.path,
        windows: "1h",
        mode: .demo,
        codexAccount: false
      ),
      onEnvelope: { _ in
        connected.fulfill()
      },
      onState: { state in
        guard case .failed(let message) = state else { return }
        XCTAssertEqual(
          message,
          localized(
            "sidecar.error.heartbeatTimeout",
            fallback: "Collection engine stopped responding."
          )
        )
        failed.fulfill()
        client.stop {
          stopped.fulfill()
        }
      }
    )

    wait(for: [connected, failed, stopped], timeout: 5)
  }
}

private final class FakeSidecarClient: SidecarControlling {
  private(set) var startCount = 0
  private(set) var stopCount = 0
  private var onEnvelope: ((SnapshotEnvelope) -> Void)?
  private var onState: ((SidecarState) -> Void)?
  private var stopCompletion: (() -> Void)?

  func start(
    configuration: SidecarConfiguration,
    onEnvelope: @escaping (SnapshotEnvelope) -> Void,
    onState: @escaping (SidecarState) -> Void
  ) {
    _ = configuration
    startCount += 1
    self.onEnvelope = onEnvelope
    self.onState = onState
  }

  func stop(completion: (() -> Void)?) {
    stopCount += 1
    stopCompletion = completion
  }

  func sendState(_ state: SidecarState) {
    onState?(state)
  }

  func sendEnvelope(_ envelope: SnapshotEnvelope) {
    onEnvelope?(envelope)
  }

  func completeStop() {
    let completion = stopCompletion
    stopCompletion = nil
    completion?()
  }
}

final class DashboardTintTests: XCTestCase {
  func testUsageTintEscalatesAcrossThresholds() {
    XCTAssertEqual(usageTint(0), .accentColor)
    XCTAssertEqual(usageTint(74.9), .accentColor)
    XCTAssertEqual(usageTint(75), .orange)
    XCTAssertEqual(usageTint(89.9), .orange)
    XCTAssertEqual(usageTint(90), .red)
    XCTAssertEqual(usageTint(150), .red)
  }

  func testProviderTintIsStableAndCaseInsensitive() {
    XCTAssertEqual(
      providerColorHex(providerTint("Codex")),
      providerColorHex(providerTint("codex"))
    )
    XCTAssertNotEqual(
      providerColorHex(providerTint("Codex")),
      providerColorHex(providerTint("Claude"))
    )
    XCTAssertEqual(
      providerColorHex(providerTint("qwen")),
      providerColorHex(providerTint("QWEN"))
    )
    XCTAssertEqual(
      providerColorHex(
        providerTint(
          "qwen",
          overrides: ["qwen": "#123456"]
        )
      ),
      "#123456"
    )
  }

  func testProviderColorNormalizationRejectsInvalidValues() {
    XCTAssertEqual(normalizedProviderColorHex(" a1b2c3 "), "#A1B2C3")
    XCTAssertNil(normalizedProviderColorHex("#12345"))
    XCTAssertNil(normalizedProviderColorHex("#12GG56"))
    XCTAssertEqual(
      normalizedProviderColorOverrides([
        " QWEN ": "abcdef",
        "bad provider": "#123456",
        "claude": "invalid",
      ]),
      ["qwen": "#ABCDEF"]
    )
  }
}

final class DashboardProviderVisibilityTests: XCTestCase {
  func testProviderWithoutUsageIsHidden() {
    let snapshot = makeSnapshot(windows: [makeWindow()])

    XCTAssertFalse(
      hasReportedUsage(provider: "claude", snapshot: snapshot)
    )
    XCTAssertEqual(observedProviders(in: snapshot), [])
  }

  func testMeasuredZeroUsageRemainsVisible() {
    let aggregate = makeAggregate(
      provider: "claude",
      observations: 1,
      total: 0
    )
    let snapshot = makeSnapshot(
      windows: [makeWindow(providers: ["claude": aggregate])]
    )

    XCTAssertTrue(
      hasReportedUsage(provider: "claude", snapshot: snapshot)
    )
  }

  func testProviderStaysVisibleWhenTheSelectedWindowIsEmpty() {
    let snapshot = makeSnapshot(windows: [
      makeWindow(label: "1h"),
      makeWindow(
        label: "12h",
        providers: [
          "codex": makeAggregate(
            provider: "codex",
            observations: 4,
            total: 8_000
          )
        ]
      ),
    ])

    XCTAssertTrue(
      hasReportedUsage(provider: "codex", snapshot: snapshot)
    )
    XCTAssertFalse(
      hasReportedUsage(provider: "claude", snapshot: snapshot)
    )
    XCTAssertEqual(observedProviders(in: snapshot), ["codex"])
  }

  func testObservedProvidersUseCanonicalOrder() {
    let snapshot = makeSnapshot(windows: [
      makeWindow(
        providers: [
          "claude": makeAggregate(
            provider: "claude",
            observations: 1,
            total: 10
          ),
          "codex": makeAggregate(
            provider: "codex",
            observations: 1,
            total: 10
          ),
        ]
      )
    ])

    XCTAssertEqual(
      observedProviders(in: snapshot),
      ["codex", "claude"]
    )
  }

  func testLiveObservationMakesProviderVisibleWithoutWindowAggregate() {
    let activity = LiveActivityDTO(
      historyWindowMs: 60_000,
      sampleIntervalMs: 1_000,
      rateWindowMs: 60_000,
      all: makeActivity(provider: "all", observations: 1),
      providers: [
        "codex": makeActivity(provider: "codex", observations: 1)
      ],
      series: [:],
      rateSeries: nil
    )
    let snapshot = makeSnapshot(
      windows: [makeWindow()],
      liveActivity: activity
    )

    XCTAssertTrue(
      hasReportedUsage(provider: "codex", snapshot: snapshot)
    )
    XCTAssertEqual(observedProviders(in: snapshot), ["codex"])
  }

  func testQuotaVisibilityUsesWindowPresence() {
    let empty = QuotaSnapshotDTO(
      provider: "claude",
      timestamp: 1_000,
      planType: nil,
      primary: nil,
      secondary: nil
    )
    let zeroPercent = QuotaSnapshotDTO(
      provider: "claude",
      timestamp: 1_000,
      planType: "max",
      primary: QuotaWindowDTO(
        usedPercent: 0,
        windowMs: 18_000_000,
        resetsAt: nil
      ),
      secondary: nil
    )

    XCTAssertFalse(hasReportedQuota(empty))
    XCTAssertTrue(hasReportedQuota(zeroPercent))
  }

  func testProviderOrderAndPlanLabelsStayPredictable() {
    XCTAssertEqual(
      canonicalProviderOrder([
        "zed", "vllm", "claude", "gemini", "alpha", "codex",
      ]),
      ["codex", "claude", "gemini", "vllm", "alpha", "zed"]
    )
    XCTAssertEqual(quotaPlanLabel(" max "), "Max")
    XCTAssertNil(quotaPlanLabel(" \n "))
    XCTAssertNil(quotaPlanLabel(nil))
  }

  func testDetectedClaudePlanIsVisibleWithoutInventingQuota() {
    let detected = ProviderAccountStatusDTO(
      provider: "claude",
      observedAt: 1_000,
      loggedIn: true,
      subscriptionType: "max"
    )
    let snapshot = makeSnapshot(
      accounts: ["claude": detected]
    )

    XCTAssertEqual(
      detectedAccountPlan(provider: "claude", snapshot: snapshot),
      "Max"
    )
    XCTAssertEqual(visiblePlanProviders(in: snapshot), ["claude"])
    XCTAssertNil(snapshot.quotas["claude"])
  }

  func testLoggedOutClaudeAccountDoesNotCreateAPlanSection() {
    let loggedOut = ProviderAccountStatusDTO(
      provider: "claude",
      observedAt: 1_000,
      loggedIn: false,
      subscriptionType: "max"
    )
    let snapshot = makeSnapshot(
      accounts: ["claude": loggedOut]
    )

    XCTAssertNil(
      detectedAccountPlan(provider: "claude", snapshot: snapshot)
    )
    XCTAssertEqual(visiblePlanProviders(in: snapshot), [])
  }

  private func makeSnapshot(
    windows: [WindowAggregateDTO] = [],
    liveActivity: LiveActivityDTO? = nil,
    accounts: [String: ProviderAccountStatusDTO]? = nil
  ) -> UsageSnapshotDTO {
    UsageSnapshotDTO(
      generatedAt: 1_000,
      windows: windows,
      focusWindow: "1h",
      recentTokensPerMinute: 0,
      recentRateWindowMs: nil,
      liveRate: nil,
      liveActivity: liveActivity,
      series: [:],
      seriesByWindow: nil,
      quotas: [:],
      accounts: accounts,
      sources: [:]
    )
  }

  private func makeWindow(
    label: String = "1h",
    providers: [String: ProviderAggregateDTO] = [:]
  ) -> WindowAggregateDTO {
    WindowAggregateDTO(
      label: label,
      durationMs: 3_600_000,
      all: makeAggregate(provider: "all"),
      providers: providers
    )
  }

  private func makeAggregate(
    provider: String,
    observations: Int = 0,
    total: Int64 = 0
  ) -> ProviderAggregateDTO {
    ProviderAggregateDTO(
      provider: provider,
      observations: observations,
      freshInput: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      total: total,
      lastEventAt: nil
    )
  }

  private func makeActivity(
    provider: String,
    observations: Int
  ) -> ProviderActivityDTO {
    ProviderActivityDTO(
      provider: provider,
      observedTokens: 0,
      tokensPerSecond: 0,
      observations: observations,
      lastEventAt: nil
    )
  }
}

final class DashboardModeTests: XCTestCase {
  func testModesAreOrderedNowHistoryLimits() {
    XCTAssertEqual(
      DashboardMode.allCases,
      [.now, .history, .limits]
    )
    XCTAssertEqual(DashboardMode.allCases.first, .now)
  }

  func testModeIdentityIsStableForPickerTags() {
    XCTAssertEqual(DashboardMode.now.id, "now")
    XCTAssertEqual(DashboardMode.history.id, "history")
    XCTAssertEqual(DashboardMode.limits.id, "limits")
  }

  func testModesUseContentAppropriateStablePanelHeights() {
    XCTAssertEqual(DashboardMode.now.panelHeight, 620)
    XCTAssertEqual(DashboardMode.history.panelHeight, 430)
    XCTAssertEqual(DashboardMode.limits.panelHeight, 320)

    XCTAssertGreaterThan(
      DashboardMode.now.panelHeight,
      DashboardMode.history.panelHeight
    )
    XCTAssertGreaterThan(
      DashboardMode.history.panelHeight,
      DashboardMode.limits.panelHeight
    )
  }
}

final class ChartScaleTests: XCTestCase {
  func testNiceCeilingRoundsToReadableSteps() {
    XCTAssertEqual(niceScaleCeiling(0), 1)
    XCTAssertEqual(niceScaleCeiling(0.4), 1)
    XCTAssertEqual(niceScaleCeiling(1.5), 2)
    XCTAssertEqual(niceScaleCeiling(342), 500)
    XCTAssertEqual(niceScaleCeiling(600), 1_000)
  }

  func testCeilingGrowsImmediatelySoASpikeIsNeverClipped() {
    XCTAssertEqual(
      stableScaleCeiling(peak: 342, previous: 100),
      500
    )
  }

  func testCeilingHoldsWhileThePeakStaysInTheUpperHalf() {
    // A sliding window whose peak dips only slightly must not re-scale.
    XCTAssertEqual(
      stableScaleCeiling(peak: 300, previous: 500),
      500
    )
    XCTAssertEqual(
      stableScaleCeiling(peak: 251, previous: 500),
      500
    )
  }

  func testCeilingShrinksOnlyAfterThePeakHalves() {
    // Just past the halfway point the readable step is still 500, so the
    // scale is unchanged either way.
    XCTAssertEqual(
      stableScaleCeiling(peak: 240, previous: 500),
      500
    )
    // Well below half, the scale finally steps down.
    XCTAssertEqual(
      stableScaleCeiling(peak: 120, previous: 500),
      200
    )
  }

  func testIdlePeakFallsBackToAUnitCeiling() {
    XCTAssertEqual(stableScaleCeiling(peak: 0, previous: 1), 1)
  }
}

final class ProviderEventMarkTests: XCTestCase {
  func testMarksTakeEachProvidersHeaviestBucketsOnly() {
    let activity = makeActivity(series: [
      "codex": buckets([0, 500, 10, 0, 900]),
      "claude": buckets([0, 0, 0, 40, 0]),
    ])

    let marks = providerEventMarks(
      activity: activity,
      providers: ["codex", "claude"]
    )

    XCTAssertEqual(marks.count, 3)
    let codex = marks.filter { $0.provider == "codex" }
    XCTAssertEqual(Set(codex.map(\.tokens)), [900, 500])
    XCTAssertEqual(marks.filter { $0.provider == "claude" }.count, 1)
  }

  func testMarksAreCappedAtTwoPerProvider() {
    let activity = makeActivity(series: [
      "codex": buckets([1, 2, 3, 4, 5]),
      "claude": buckets([1, 2, 3, 4, 5]),
    ])

    let marks = providerEventMarks(
      activity: activity,
      providers: ["codex", "claude"]
    )

    XCTAssertEqual(marks.count, 4)
  }

  func testEmptyAndUnobservedProvidersProduceNoMarks() {
    let activity = makeActivity(series: [
      "codex": buckets([0, 0, 0]),
      "claude": [],
    ])

    XCTAssertEqual(
      providerEventMarks(
        activity: activity,
        providers: ["codex", "claude", "zed"]
      ),
      []
    )
  }

  func testPositionsAreNormalisedAndSortedOldestFirst() {
    let activity = makeActivity(series: [
      "codex": buckets([7, 0, 0, 0, 9])
    ])

    let marks = providerEventMarks(
      activity: activity,
      providers: ["codex"]
    )

    XCTAssertEqual(marks.map(\.position), [0, 1])
  }

  func testSingleBucketSeriesAnchorsAtNow() {
    let activity = makeActivity(series: ["codex": buckets([5])])

    XCTAssertEqual(
      providerEventMarks(activity: activity, providers: ["codex"]),
      [ProviderEventMark(provider: "codex", position: 1, tokens: 5)]
    )
  }

  private func buckets(_ tokens: [Int64]) -> [BucketPointDTO] {
    tokens.enumerated().map {
      BucketPointDTO(start: Double($0.offset) * 1_000, tokens: $0.element)
    }
  }

  private func makeActivity(
    series: [String: [BucketPointDTO]]
  ) -> LiveActivityDTO {
    LiveActivityDTO(
      historyWindowMs: 60_000,
      sampleIntervalMs: 1_000,
      rateWindowMs: 60_000,
      all: ProviderActivityDTO(
        provider: "all",
        observedTokens: 0,
        tokensPerSecond: 0,
        observations: 0,
        lastEventAt: nil
      ),
      providers: [:],
      series: series,
      rateSeries: nil
    )
  }
}

final class QuotaPreviewSelectionTests: XCTestCase {
  func testPreviewPicksTheMostConsumedVerifiedWindow() {
    let quota = QuotaSnapshotDTO(
      provider: "claude",
      timestamp: 1_000,
      planType: "max",
      primary: QuotaWindowDTO(
        usedPercent: 12,
        windowMs: 5 * 3_600_000,
        resetsAt: nil
      ),
      secondary: QuotaWindowDTO(
        usedPercent: 68,
        windowMs: 7 * 24 * 3_600_000,
        resetsAt: nil
      )
    )

    XCTAssertEqual(
      mostConsumedVerifiedWindow(quota)?.usedPercent,
      68
    )
  }

  func testPreviewUsesTheOnlyVerifiedWindowWhenOneExists() {
    let quota = QuotaSnapshotDTO(
      provider: "codex",
      timestamp: 1_000,
      planType: "pro",
      primary: nil,
      secondary: QuotaWindowDTO(
        usedPercent: 5,
        windowMs: 7 * 24 * 3_600_000,
        resetsAt: 2_000
      )
    )

    XCTAssertEqual(mostConsumedVerifiedWindow(quota)?.usedPercent, 5)
  }

  func testDetectedPlanWithoutVerifiedUsageNeverReachesThePreview() {
    let detectedOnly = QuotaSnapshotDTO(
      provider: "claude",
      timestamp: 1_000,
      planType: "max",
      primary: nil,
      secondary: nil
    )

    XCTAssertNil(mostConsumedVerifiedWindow(detectedOnly))
    XCTAssertFalse(hasReportedQuota(detectedOnly))
  }

  func testAMeasuredZeroIsStillAVerifiedPreview() {
    let quota = QuotaSnapshotDTO(
      provider: "codex",
      timestamp: 1_000,
      planType: nil,
      primary: QuotaWindowDTO(
        usedPercent: 0,
        windowMs: 7 * 24 * 3_600_000,
        resetsAt: nil
      ),
      secondary: nil
    )

    XCTAssertEqual(mostConsumedVerifiedWindow(quota)?.usedPercent, 0)
    XCTAssertTrue(hasReportedQuota(quota))
  }
}

final class TokenCompositionOrderTests: XCTestCase {
  func testSlicesDrawInTheSelectedDesignOrder() {
    XCTAssertEqual(
      TokenCompositionKind.allCases,
      [.context, .cache, .output, .reasoning]
    )
  }

  func testEveryKindHasADistinctTint() {
    let tints = TokenCompositionKind.allCases.map(\.tint)
    XCTAssertEqual(Set(tints).count, TokenCompositionKind.allCases.count)
  }
}

final class TokenCompositionPresentationTests: XCTestCase {
  func testReasoningIsRemovedFromOutputInsteadOfDoubleCounted() {
    let composition = TokenCompositionPresentation(
      aggregate: makeAggregate(
        freshInput: 100,
        cacheRead: 30,
        cacheWrite: 20,
        output: 80,
        reasoning: 30
      )
    )

    XCTAssertEqual(composition.context, 100)
    XCTAssertEqual(composition.cache, 50)
    XCTAssertEqual(composition.reasoning, 30)
    XCTAssertEqual(composition.output, 50)
    XCTAssertEqual(composition.displayedTotal, 230)
  }

  func testReasoningLargerThanOutputIsClampedAndEmptiesVisibleOutput() {
    let composition = TokenCompositionPresentation(
      aggregate: makeAggregate(output: 40, reasoning: 90)
    )

    XCTAssertEqual(composition.reasoning, 40)
    XCTAssertEqual(composition.output, 0)
    XCTAssertEqual(composition.displayedTotal, 40)
  }

  func testNegativeCountsFloorAtZero() {
    let composition = TokenCompositionPresentation(
      aggregate: makeAggregate(
        freshInput: -10,
        cacheRead: -5,
        cacheWrite: 10,
        output: -20,
        reasoning: -30
      )
    )

    XCTAssertEqual(composition.context, 0)
    XCTAssertEqual(composition.cache, 10)
    XCTAssertEqual(composition.reasoning, 0)
    XCTAssertEqual(composition.output, 0)
    XCTAssertEqual(composition.displayedTotal, 10)
  }

  func testZeroDenominatorReportsEmptyRatherThanASplit() {
    let measuredZero = TokenCompositionPresentation(
      aggregate: makeAggregate()
    )
    let missing = TokenCompositionPresentation(aggregate: nil)

    XCTAssertTrue(measuredZero.isEmpty)
    XCTAssertTrue(missing.isEmpty)
    XCTAssertEqual(missing.displayedTotal, 0)
    XCTAssertEqual(missing.fraction(.output), 0)
    for percent in missing.percentages().values {
      XCTAssertEqual(percent, 0)
    }
  }

  func testPercentagesSumToOneHundredWithoutCreditingEmptySlices() {
    let composition = TokenCompositionPresentation(
      aggregate: makeAggregate(
        freshInput: 1,
        cacheRead: 1,
        cacheWrite: 0,
        output: 1,
        reasoning: 0
      )
    )
    let percentages = composition.percentages()

    XCTAssertEqual(percentages.values.reduce(0, +), 100)
    XCTAssertEqual(percentages[.reasoning], 0)
    XCTAssertFalse(composition.isEmpty)
  }

  func testFractionsUseTheDisplayedTotalNotTheReportedTotal() {
    // `total` on the wire includes cache reads; the strip must divide by the
    // sum of the slices it actually draws.
    let composition = TokenCompositionPresentation(
      aggregate: makeAggregate(
        freshInput: 25,
        cacheRead: 25,
        cacheWrite: 25,
        output: 25,
        reasoning: 0,
        total: 9_999
      )
    )

    XCTAssertEqual(composition.displayedTotal, 100)
    XCTAssertEqual(composition.fraction(.context), 0.25, accuracy: 0.0001)
    XCTAssertEqual(composition.fraction(.cache), 0.5, accuracy: 0.0001)
  }

  private func makeAggregate(
    freshInput: Int64 = 0,
    cacheRead: Int64 = 0,
    cacheWrite: Int64 = 0,
    output: Int64 = 0,
    reasoning: Int64 = 0,
    total: Int64 = 0
  ) -> ProviderAggregateDTO {
    ProviderAggregateDTO(
      provider: "codex",
      observations: 1,
      freshInput: freshInput,
      cacheRead: cacheRead,
      cacheWrite: cacheWrite,
      output: output,
      reasoning: reasoning,
      total: total,
      lastEventAt: nil
    )
  }
}

final class QuotaWindowPresentationTests: XCTestCase {
  func testCompactWindowLabelUsesHoursAndWholeDays() {
    XCTAssertEqual(
      QuotaWindowPresentation.compactWindowLabel(5 * 3_600_000),
      "5h"
    )
    XCTAssertEqual(
      QuotaWindowPresentation.compactWindowLabel(3 * 3_600_000),
      "3h"
    )
    XCTAssertEqual(
      QuotaWindowPresentation.compactWindowLabel(24 * 3_600_000),
      "1d"
    )
    XCTAssertEqual(
      QuotaWindowPresentation.compactWindowLabel(7 * 24 * 3_600_000),
      "7d"
    )
  }

  func testPresentationRoundsPercentAndKeepsReset() {
    let presentation = QuotaWindowPresentation(
      window: QuotaWindowDTO(
        usedPercent: 74.6,
        windowMs: 5 * 3_600_000,
        resetsAt: 1_000
      )
    )

    XCTAssertEqual(presentation.compactWindow, "5h")
    XCTAssertEqual(presentation.usedPercent, 75)
    XCTAssertEqual(presentation.resetsAt, 1_000)
    XCTAssertEqual(presentation.tint, .orange)
  }

  func testTintFollowsTheRoundedPercentIntoTheDangerBand() {
    let presentation = QuotaWindowPresentation(
      window: QuotaWindowDTO(
        usedPercent: 89.6,
        windowMs: 7 * 24 * 3_600_000,
        resetsAt: nil
      )
    )

    XCTAssertEqual(presentation.compactWindow, "7d")
    XCTAssertEqual(presentation.usedPercent, 90)
    XCTAssertEqual(presentation.tint, .red)
    XCTAssertNil(presentation.resetsAt)
  }

  func testQuotaMeterUsesTheRoundedClampedDisplayValue() {
    let belowZero = QuotaWindowPresentation(
      window: QuotaWindowDTO(
        usedPercent: -1.6,
        windowMs: 5 * 3_600_000,
        resetsAt: nil
      )
    )
    let aboveLimit = QuotaWindowPresentation(
      window: QuotaWindowDTO(
        usedPercent: 101.2,
        windowMs: 5 * 3_600_000,
        resetsAt: nil
      )
    )

    XCTAssertEqual(belowZero.usedPercent, -2)
    XCTAssertEqual(belowZero.meterValue, 0)
    XCTAssertEqual(aboveLimit.usedPercent, 101)
    XCTAssertEqual(aboveLimit.meterValue, 100)
  }
}

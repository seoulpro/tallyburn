import AppKit
import SwiftUI

private struct SettingsDraft: Equatable {
  var mode: MonitoringMode
  var windows: String
  var codexAccount: Bool
  var otelMetrics: Bool
  var llamaCppMetricsURL: String
  var vllmMetricsURL: String
  var cliPath: String
  var showRateInMenuBar: Bool
  var miniMonitorEnabled: Bool
  var launchAtLogin: Bool
  var providerColors: [String: String]

  @MainActor
  init(model: AppModel) {
    mode = model.mode
    windows = model.windows
    codexAccount = model.codexAccount
    otelMetrics = model.otelMetrics
    llamaCppMetricsURL = model.llamaCppMetricsURL
    vllmMetricsURL = model.vllmMetricsURL
    cliPath = model.cliPath
    showRateInMenuBar = model.showRateInMenuBar
    miniMonitorEnabled = model.miniMonitorEnabled
    launchAtLogin = model.launchAtLogin
    providerColors = model.providerColors
  }
}

@MainActor
struct SettingsView: View {
  @ObservedObject var model: AppModel
  @State private var draft: SettingsDraft
  @State private var appliedDraft: SettingsDraft

  private enum Layout {
    static let windowWidth: CGFloat = 520
    static let minimumHeight: CGFloat = 620
  }

  init(model: AppModel) {
    self.model = model
    let draft = SettingsDraft(model: model)
    _draft = State(initialValue: draft)
    _appliedDraft = State(initialValue: draft)
  }

  var body: some View {
    VStack(spacing: 0) {
      Form {
        monitoringSection
        localModelsSection
        appearanceSection
        helperSection
        macOSSection

        if let error = model.settingsError {
          settingsError(error)
        }

        aboutSection
      }
      .formStyle(.grouped)

      Divider()

      applyBar
    }
    .frame(width: Layout.windowWidth)
    .frame(minHeight: Layout.minimumHeight)
  }

  private var appearanceSection: some View {
    Section(
      localized(
        "settings.section.appearance",
        fallback: "Provider Colors"
      )
    ) {
      ForEach(model.configurableProviders, id: \.self) { provider in
        ColorPicker(
          providerDisplayName(provider),
          selection: providerColorBinding(provider),
          supportsOpacity: false
        )
        .accessibilityHint(
          localizedFormat(
            "settings.providerColor.hint",
            fallback: "Choose the color used for %@ in charts and meters.",
            providerDisplayName(provider)
          )
        )
      }

      HStack(alignment: .firstTextBaseline) {
        Text(
          localized(
            "settings.providerColor.help",
            fallback:
              "New providers appear here after Tallyburn observes them."
          )
        )
        .font(.caption)
        .foregroundStyle(.secondary)

        Spacer()

        Button(
          localized(
            "settings.providerColor.restore",
            fallback: "Restore Defaults"
          )
        ) {
          draft.providerColors = [:]
        }
        .disabled(draft.providerColors.isEmpty)
      }
    }
  }

  private var monitoringSection: some View {
    Section(
      localized(
        "settings.section.monitoring",
        fallback: "Monitoring"
      )
    ) {
      Picker(
        localized("settings.mode", fallback: "Mode"),
        selection: $draft.mode
      ) {
        ForEach(MonitoringMode.allCases) { item in
          Text(item.title).tag(item)
        }
      }

      Text(draft.mode.privacyDescription)
        .font(.caption)
        .foregroundStyle(.secondary)

      TextField(
        localized(
          "settings.rollingWindows",
          fallback: "Rolling windows"
        ),
        text: $draft.windows
      )
      .help(
        localized(
          "settings.rollingWindows.help",
          fallback:
            "Comma-separated durations, for example 1h,3h,12h"
        )
      )

      Toggle(
        localized(
          "settings.codexPlanLimits",
          fallback: "Show Codex usage limits"
        ),
        isOn: $draft.codexAccount
      )
      .disabled(draft.mode != .standard)

      Text(
        localized(
          "settings.codexPlanLimits.help",
          fallback:
            "Uses your existing Codex sign-in to read provider-reported usage percentages and reset times. It does not run a model or spend tokens."
        )
      )
      .font(.caption)
      .foregroundStyle(.secondary)

      if draft.mode == .standard {
        Toggle(
          localized(
            "settings.otelMetrics",
            fallback: "Receive live CLI metrics"
          ),
          isOn: $draft.otelMetrics
        )

        Text(
          localized(
            "settings.otelMetrics.help",
            fallback:
              "Listens for numeric Claude, Gemini, GitHub Copilot, and Qwen telemetry through local OTLP. Each CLI must be configured separately."
          )
        )
        .font(.caption)
        .foregroundStyle(.secondary)
      }

      if receivesOTLPMetrics {
        Menu {
          Button("Claude Code") {
            copyClaudeLaunchCommand()
          }
          Button("Gemini CLI") {
            copyGeminiLaunchCommand()
          }
          Button("GitHub Copilot CLI") {
            copyCopilotLaunchCommand()
          }
          Button("Qwen Code") {
            copyQwenLaunchCommand()
          }
        } label: {
          Label(
            localized(
              "settings.otel.copyCommand",
              fallback: "Copy Telemetry Launch Command"
            ),
            systemImage: "doc.on.doc"
          )
        }
        .help(
          localized(
            "settings.otel.copyCommand.help",
            fallback:
              "Copies a provider command that sends numeric token telemetry to Tallyburn."
          )
        )
      }
    }
  }

  private var receivesOTLPMetrics: Bool {
    draft.mode == .metricsOnly
      || (draft.mode == .standard && draft.otelMetrics)
  }

  private var localModelsSection: some View {
    Section(
      localized(
        "settings.section.localModels",
        fallback: "Local Model Servers"
      )
    ) {
      LabeledContent("llama.cpp") {
        TextField(
          "",
          text: $draft.llamaCppMetricsURL,
          prompt: Text("http://127.0.0.1:8080/metrics")
        )
        .textFieldStyle(.roundedBorder)
        .labelsHidden()
      }

      LabeledContent("vLLM") {
        TextField(
          "",
          text: $draft.vllmMetricsURL,
          prompt: Text("http://127.0.0.1:8000/metrics")
        )
        .textFieldStyle(.roundedBorder)
        .labelsHidden()
      }

      Text(
        localized(
          "settings.localModels.help",
          fallback:
            "Optional loopback endpoints. Enable each server's Prometheus metrics; Tallyburn starts counting new tokens after it connects."
        )
      )
      .font(.caption)
      .foregroundStyle(.secondary)
    }
  }

  private var helperSection: some View {
    Section(
      localized(
        "settings.section.helper",
        fallback: "Collection Engine (Advanced)"
      )
    ) {
      LabeledContent(
        localized(
          "settings.cliPath",
          fallback: "Tallyburn CLI path"
        )
      ) {
        HStack {
          TextField(
            "",
            text: $draft.cliPath,
            prompt: Text(
              localized(
                "settings.cliPath.placeholder",
                fallback: "Automatic"
              )
            )
          )
          .textFieldStyle(.roundedBorder)
          .labelsHidden()

          Button(
            localized(
              "settings.choose",
              fallback: "Choose…"
            )
          ) {
            chooseCLI()
          }
        }
      }

      Text(
        localized(
          "settings.cliPath.help",
          fallback:
            "Most people should leave this blank. The app automatically finds its bundled collection engine or a standard Tallyburn installation."
        )
      )
      .font(.caption)
      .foregroundStyle(.secondary)
    }
  }

  private var macOSSection: some View {
    Section(
      localized(
        "settings.section.macOS",
        fallback: "Menu Bar & Login"
      )
    ) {
      Toggle(
        localized(
          "settings.showRate",
          fallback: "Show average tokens per second in menu bar"
        ),
        isOn: $draft.showRateInMenuBar
      )

      Text(
        localized(
          "settings.showRate.help",
          fallback:
            "Shows the recent moving average as tokens per second. Keep it off when menu bar space is limited by the camera notch."
        )
      )
      .font(.caption)
      .foregroundStyle(.secondary)

      Toggle(
        localized(
          "settings.miniMonitor",
          fallback: "Use mini monitor"
        ),
        isOn: $draft.miniMonitorEnabled
      )

      Text(
        localized(
          "settings.miniMonitor.help",
          fallback:
            "Shows the live average, activity graph, and rolling total in a compact panel."
        )
      )
      .font(.caption)
      .foregroundStyle(.secondary)

      Toggle(
        localized(
          "settings.launchAtLogin",
          fallback: "Launch at login"
        ),
        isOn: $draft.launchAtLogin
      )
    }
  }

  private func settingsError(_ error: String) -> some View {
    Section {
      Label {
        Text(error)
          .foregroundStyle(.primary)
      } icon: {
        Image(systemName: "exclamationmark.triangle.fill")
          .foregroundStyle(.red)
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(
        localizedFormat(
          "settings.error.accessibility",
          fallback: "Settings error: %@",
          error
        )
      )
    }
  }

  private var aboutSection: some View {
    Section(
      localized(
        "settings.section.about",
        fallback: "About Tallyburn"
      )
    ) {
      Text(
        localized(
          "settings.about.summary",
          fallback:
            "A local-first activity monitor for supported AI coding CLIs and model servers."
        )
      )
      .foregroundStyle(.secondary)

      LabeledContent(
        localized(
          "settings.about.version",
          fallback: "Version"
        ),
        value: versionLabel
      )

      HStack {
        Link(
          localized(
            "settings.about.website",
            fallback: "Project Website"
          ),
          destination: URL(
            string: "https://github.com/seoulpro/tallyburn"
          )!
        )

        Button(
          localized(
            "settings.about.license",
            fallback: "Open License"
          )
        ) {
          openBundledLicense()
        }
      }
    }
  }

  private var applyBar: some View {
    HStack {
      Text(
        hasChanges
          ? pendingChangesDescription
          : localized(
            "settings.changes.applied",
            fallback: "All changes are applied."
          )
      )
      .font(.caption)
      .foregroundStyle(.secondary)

      Spacer()

      Button(
        localized(
          "settings.revert",
          fallback: "Revert"
        )
      ) {
        draft = appliedDraft
        model.clearSettingsError()
      }
      .disabled(!hasChanges)

      Button(
        monitoringSettingsChanged
          ? localized(
            "settings.applyAndRestart",
            fallback: "Apply & Restart"
          )
          : localized(
            "settings.apply",
            fallback: "Apply"
          )
      ) {
        apply()
      }
      .buttonStyle(.borderedProminent)
      .keyboardShortcut(.defaultAction)
      .disabled(!hasChanges)
    }
    .padding()
  }

  private var hasChanges: Bool {
    draft != appliedDraft
  }

  private var monitoringSettingsChanged: Bool {
    draft.mode != appliedDraft.mode
      || draft.windows != appliedDraft.windows
      || draft.codexAccount != appliedDraft.codexAccount
      || draft.otelMetrics != appliedDraft.otelMetrics
      || draft.llamaCppMetricsURL != appliedDraft.llamaCppMetricsURL
      || draft.vllmMetricsURL != appliedDraft.vllmMetricsURL
      || draft.cliPath != appliedDraft.cliPath
  }

  private var pendingChangesDescription: String {
    monitoringSettingsChanged
      ? localized(
        "settings.changes.pending",
        fallback:
          "Changes apply together and restart monitoring once."
      )
      : localized(
        "settings.changes.pendingWithoutRestart",
        fallback:
          "Changes apply without restarting monitoring."
      )
  }

  private var versionLabel: String {
    let version =
      Bundle.main.object(
        forInfoDictionaryKey: "CFBundleShortVersionString"
      ) as? String ?? "—"
    let build =
      Bundle.main.object(
        forInfoDictionaryKey: "CFBundleVersion"
      ) as? String ?? "—"
    return localizedFormat(
      "settings.about.versionValue",
      fallback: "%@ (%@)",
      version,
      build
    )
  }

  private func apply() {
    guard
      model.applySettings(
        mode: draft.mode,
        windows: draft.windows,
        codexAccount: draft.codexAccount,
        otelMetrics: draft.otelMetrics,
        llamaCppMetricsURL: draft.llamaCppMetricsURL,
        vllmMetricsURL: draft.vllmMetricsURL,
        cliPath: draft.cliPath
      )
    else {
      return
    }

    model.setShowRateInMenuBar(draft.showRateInMenuBar)
    model.setMiniMonitorEnabled(draft.miniMonitorEnabled)
    model.setProviderColors(draft.providerColors)
    if draft.launchAtLogin != model.launchAtLogin {
      model.setLaunchAtLogin(draft.launchAtLogin)
    }

    let current = SettingsDraft(model: model)
    draft = current
    appliedDraft = current
  }

  private func providerColorBinding(
    _ provider: String
  ) -> Binding<Color> {
    Binding(
      get: {
        providerTint(
          provider,
          overrides: draft.providerColors
        )
      },
      set: { color in
        guard let hex = providerColorHex(color) else { return }
        let key = canonicalProviderKey(provider)
        if hex == defaultProviderColorHex(provider) {
          draft.providerColors.removeValue(forKey: key)
        } else {
          draft.providerColors[key] = hex
        }
      }
    )
  }

  private func chooseCLI() {
    let panel = NSOpenPanel()
    panel.title = localized(
      "settings.cliPicker.title",
      fallback: "Choose Tallyburn CLI"
    )
    panel.message = localized(
      "settings.cliPicker.message",
      fallback:
        "Choose the Tallyburn executable or its JavaScript entry point."
    )
    panel.prompt = localized(
      "settings.cliPicker.prompt",
      fallback: "Choose"
    )
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = false

    let expandedPath = NSString(string: draft.cliPath)
      .expandingTildeInPath
    if !expandedPath.isEmpty {
      panel.directoryURL = URL(fileURLWithPath: expandedPath)
        .deletingLastPathComponent()
    }

    guard panel.runModal() == .OK,
      let selectedURL = panel.url
    else {
      return
    }
    draft.cliPath = selectedURL.path
  }

  private func copyQwenLaunchCommand() {
    let command =
      "QWEN_TELEMETRY_ENABLED=true "
      + "QWEN_TELEMETRY_OTLP_PROTOCOL=http "
      + "QWEN_TELEMETRY_OTLP_ENDPOINT=http://127.0.0.1:4318 qwen"
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(command, forType: .string)
  }

  private func copyClaudeLaunchCommand() {
    let command =
      "CLAUDE_CODE_ENABLE_TELEMETRY=1 "
      + "OTEL_METRICS_EXPORTER=otlp "
      + "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/json "
      + "OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 claude"
    copyToPasteboard(command)
  }

  private func copyGeminiLaunchCommand() {
    let command =
      "GEMINI_TELEMETRY_ENABLED=true "
      + "GEMINI_TELEMETRY_TARGET=local "
      + "GEMINI_TELEMETRY_OTLP_PROTOCOL=http "
      + "GEMINI_TELEMETRY_OTLP_ENDPOINT=http://127.0.0.1:4318 gemini"
    copyToPasteboard(command)
  }

  private func copyCopilotLaunchCommand() {
    let command =
      "OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 "
      + "OTEL_EXPORTER_OTLP_PROTOCOL=http/json copilot"
    copyToPasteboard(command)
  }

  private func copyToPasteboard(_ value: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(value, forType: .string)
  }

  private func openBundledLicense() {
    guard
      let licenseURL = Bundle.main.url(
        forResource: "LICENSE",
        withExtension: nil
      )
    else {
      return
    }
    NSWorkspace.shared.open(licenseURL)
  }
}

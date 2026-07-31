import AppKit
import SwiftUI

enum SettingsPane: String, CaseIterable, Identifiable {
  case general
  case colors
  case advanced

  var id: String { rawValue }

  var title: String {
    switch self {
    case .general:
      return localized(
        "settings.tab.general",
        fallback: "General"
      )
    case .colors:
      return localized(
        "settings.tab.colors",
        fallback: "Colors"
      )
    case .advanced:
      return localized(
        "settings.tab.advanced",
        fallback: "Advanced"
      )
    }
  }

  var systemImage: String {
    switch self {
    case .general: return "gearshape"
    case .colors: return "paintpalette"
    case .advanced: return "wrench.and.screwdriver"
    }
  }

  var windowHeight: CGFloat {
    switch self {
    case .general: return 680
    case .colors: return 560
    case .advanced: return 320
    }
  }
}

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
  @State private var selectedPane: SettingsPane
  @State private var liveCLIExpanded = false
  @State private var localModelsExpanded = false
  @State private var collectionEngineExpanded = false

  private enum Layout {
    static let windowWidth: CGFloat = 520
    static let rollingWindowColumns = [
      GridItem(.flexible(), spacing: 8),
      GridItem(.flexible(), spacing: 8),
      GridItem(.flexible(), spacing: 8),
    ]
  }

  init(
    model: AppModel,
    expandAdvancedSettings: Bool = false,
    initialPane: SettingsPane? = nil
  ) {
    self.model = model
    let draft = SettingsDraft(model: model)
    _draft = State(initialValue: draft)
    _appliedDraft = State(initialValue: draft)
    _selectedPane = State(
      initialValue: initialPane ?? model.selectedSettingsPane
    )
    _liveCLIExpanded = State(
      initialValue: expandAdvancedSettings
    )
    _localModelsExpanded = State(
      initialValue: expandAdvancedSettings
    )
    _collectionEngineExpanded = State(
      initialValue: expandAdvancedSettings
    )
  }

  var body: some View {
    VStack(spacing: 0) {
      TabView(selection: $selectedPane) {
        generalPane
          .tabItem {
            Label(
              SettingsPane.general.title,
              systemImage: SettingsPane.general.systemImage
            )
          }
          .tag(SettingsPane.general)

        colorsPane
          .tabItem {
            Label(
              SettingsPane.colors.title,
              systemImage: SettingsPane.colors.systemImage
            )
          }
          .tag(SettingsPane.colors)

        advancedPane
          .tabItem {
            Label(
              SettingsPane.advanced.title,
              systemImage: SettingsPane.advanced.systemImage
            )
          }
          .tag(SettingsPane.advanced)
      }

      Divider()

      applyBar
    }
    .frame(width: Layout.windowWidth)
    .frame(height: selectedPane.windowHeight)
    .navigationTitle(
      localizedFormat(
        "settings.window.title",
        fallback: "%@ — Tallyburn Settings",
        selectedPane.title
      )
    )
    .onChange(of: selectedPane) { _, pane in
      model.setSelectedSettingsPane(pane)
    }
  }

  private var generalPane: some View {
    Form {
      monitoringSection
      macOSSection

      if let error = model.settingsError {
        settingsError(error)
      }

      aboutSection
    }
    .formStyle(.grouped)
  }

  private var colorsPane: some View {
    Form {
      appearanceSection

      if let error = model.settingsError {
        settingsError(error)
      }
    }
    .formStyle(.grouped)
  }

  private var advancedPane: some View {
    Form {
      advancedSection

      if let error = model.settingsError {
        settingsError(error)
      }
    }
    .formStyle(.grouped)
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
              "Colors stay consistent across charts and meters. Custom providers appear after they are observed."
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

      rollingWindowsPicker

      Toggle(
        localized(
          "settings.codexPlanLimits",
          fallback: "Show Codex usage limits"
        ),
        isOn: $draft.codexAccount
      )
      .disabled(draft.mode != .standard)

      Text(
        draft.mode == .standard
          ? localized(
            "settings.codexPlanLimits.help",
            fallback:
              "Uses your existing Codex sign-in to read provider-reported usage percentages and reset times. It does not run a model or spend tokens."
          )
          : localized(
            "settings.codexPlanLimits.unavailable",
            fallback:
              "Available only in Standard local monitoring."
          )
      )
      .font(.caption)
      .foregroundStyle(.secondary)
    }
  }

  private var rollingWindowsPicker: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(
        localized(
          "settings.rollingWindows",
          fallback: "Rolling totals"
        )
      )

      LazyVGrid(
        columns: Layout.rollingWindowColumns,
        spacing: 8
      ) {
        ForEach(AppRollingWindowPresets.labels, id: \.self) { label in
          Toggle(isOn: rollingWindowBinding(label)) {
            Text(rollingWindowTitle(label))
              .frame(maxWidth: .infinity)
          }
          .toggleStyle(.button)
          .disabled(rollingWindowOptionDisabled(label))
        }
      }

      HStack(alignment: .firstTextBaseline) {
        Text(
          localized(
            "settings.rollingWindows.help",
            fallback:
              "Choose 1–4 periods to compare in History."
          )
        )
        .font(.caption)
        .foregroundStyle(.secondary)

        Spacer()

        Button(
          localized(
            "settings.rollingWindows.restore",
            fallback: "Restore Defaults"
          )
        ) {
          draft.windows = AppRollingWindowPresets.defaultValue
        }
        .disabled(
          draft.windows == AppRollingWindowPresets.defaultValue
        )
      }
    }
  }

  private var receivesOTLPMetrics: Bool {
    draft.mode == .metricsOnly
      || (draft.mode == .standard && draft.otelMetrics)
  }

  private var advancedSection: some View {
    Section {
      DisclosureGroup(
        isExpanded: $liveCLIExpanded
      ) {
        liveCLISettings
          .padding(.top, 8)
      } label: {
        Label(
          localized(
            "settings.advanced.liveCLI",
            fallback: "Live CLI Data"
          ),
          systemImage: "antenna.radiowaves.left.and.right"
        )
      }

      DisclosureGroup(
        isExpanded: $localModelsExpanded
      ) {
        localModelSettings
          .padding(.top, 8)
      } label: {
        Label(
          localized(
            "settings.section.localModels",
            fallback: "Local Model Servers"
          ),
          systemImage: "server.rack"
        )
      }

      DisclosureGroup(
        isExpanded: $collectionEngineExpanded
      ) {
        collectionEngineSettings
          .padding(.top, 8)
      } label: {
        Label(
          localized(
            "settings.section.helper",
            fallback: "Collection Engine"
          ),
          systemImage: "gearshape.2"
        )
      }
    }
  }

  @ViewBuilder
  private var liveCLISettings: some View {
    VStack(alignment: .leading, spacing: 8) {
      switch draft.mode {
      case .standard:
        Toggle(
          localized(
            "settings.otelMetrics",
            fallback: "Listen for CLI telemetry"
          ),
          isOn: $draft.otelMetrics
        )
      case .metricsOnly:
        Label(
          localized(
            "settings.otelMetrics.required",
            fallback: "Enabled by Local metrics only mode"
          ),
          systemImage: "checkmark.circle.fill"
        )
        .foregroundStyle(.secondary)
      case .demo:
        Label(
          localized(
            "settings.otelMetrics.unavailable",
            fallback: "Unavailable in Demo preview"
          ),
          systemImage: "minus.circle"
        )
        .foregroundStyle(.secondary)
      }

      Text(
        localized(
          "settings.otelMetrics.help",
          fallback:
            "Optional. Listens on this Mac at 127.0.0.1:4318. Each supported CLI must be launched with telemetry enabled."
        )
      )
      .font(.caption)
      .foregroundStyle(.secondary)

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

  private var localModelSettings: some View {
    VStack(alignment: .leading, spacing: 8) {
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

  private var collectionEngineSettings: some View {
    VStack(alignment: .leading, spacing: 8) {
      LabeledContent(
        localized(
          "settings.cliPath",
          fallback: "Executable"
        )
      ) {
        HStack {
          TextField(
            "",
            text: $draft.cliPath,
            prompt: Text(
              localized(
                "settings.cliPath.placeholder",
                fallback: "Automatic (Recommended)"
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
            "Leave this blank unless you are testing another Tallyburn collection engine."
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
          fallback: "Show token rate in menu bar"
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

  private var selectedRollingWindows: Set<String> {
    Set(draft.windows.split(separator: ",").map(String.init))
  }

  private func rollingWindowBinding(
    _ label: String
  ) -> Binding<Bool> {
    Binding(
      get: {
        selectedRollingWindows.contains(label)
      },
      set: { selected in
        var values = selectedRollingWindows
        if selected {
          guard
            values.count
              < AppRollingWindowPresets.maximumSelectionCount
          else {
            return
          }
          values.insert(label)
        } else {
          guard values.count > 1 else { return }
          values.remove(label)
        }
        draft.windows =
          AppRollingWindowPresets.labels
          .filter(values.contains)
          .joined(separator: ",")
      }
    )
  }

  private func rollingWindowOptionDisabled(
    _ label: String
  ) -> Bool {
    let selected = selectedRollingWindows
    return selected.contains(label)
      ? selected.count == 1
      : selected.count
        >= AppRollingWindowPresets.maximumSelectionCount
  }

  private func rollingWindowTitle(_ label: String) -> String {
    localized(
      "settings.rollingWindow.\(label)",
      fallback: label
    )
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

import SwiftUI

@main
struct TallyburnApp: App {
  @StateObject private var model: AppModel

  init() {
    _model = StateObject(
      wrappedValue: AppModel(
        automaticallyStartsMonitoring:
          ProcessInfo.processInfo.environment[
            "XCTestConfigurationFilePath"
          ] == nil
      )
    )
  }

  var body: some Scene {
    MenuBarExtra {
      DashboardView(model: model)
    } label: {
      HStack(spacing: 4) {
        Image(systemName: model.menuIcon)
        if model.showRateInMenuBar, !model.menuTitle.isEmpty {
          Text(model.menuTitle)
            .monospacedDigit()
        }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(model.accessibilityLabel)
      .help(model.accessibilityLabel)
    }
    .menuBarExtraStyle(.window)

    Settings {
      SettingsView(model: model)
    }
  }
}

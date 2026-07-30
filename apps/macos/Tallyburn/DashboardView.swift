import AppKit
import Foundation
import SwiftUI

/// Semantic tint for a usage meter: calm accent well under the limit,
/// warning as it fills, danger once effectively exhausted.
func usageTint(_ usedPercent: Double) -> Color {
  switch usedPercent {
  case 90...: return .red
  case 75..<90: return .orange
  default: return .accentColor
  }
}

/// A provider is visible only after Tallyburn has observed usage for it, and
/// then it stays visible while any configured rolling window still holds that
/// observation. Switching to a shorter window therefore shows that window's
/// true zero instead of making the provider vanish, while a provider never
/// observed anywhere stays hidden. Observation counts deliberately keep a
/// measured zero visible.
func hasReportedUsage(
  provider: String,
  snapshot: UsageSnapshotDTO
) -> Bool {
  let activity = snapshot.liveActivity?.providers[provider]
  let rate = snapshot.liveRate?.providers[provider]

  if (activity?.observations ?? 0) > 0
    || (activity?.observedTokens ?? 0) > 0
    || (rate?.observations ?? 0) > 0
    || (rate?.observedTokens ?? 0) > 0
  {
    return true
  }

  return snapshot.windows.contains { window in
    let aggregate = window.providers[provider]
    return (aggregate?.observations ?? 0) > 0
      || (aggregate?.total ?? 0) > 0
  }
}

/// Every provider any part of the snapshot mentions, in canonical order. The
/// union spans all rolling windows so the visible set does not churn as the
/// window selector changes.
func observedProviders(in snapshot: UsageSnapshotDTO) -> [String] {
  var candidates = Set<String>()
  for window in snapshot.windows {
    candidates.formUnion(window.providers.keys)
  }
  if let activity = snapshot.liveActivity {
    candidates.formUnion(activity.providers.keys)
  }
  if let rate = snapshot.liveRate {
    candidates.formUnion(rate.providers.keys)
  }
  return canonicalProviderOrder(Array(candidates)).filter {
    hasReportedUsage(provider: $0, snapshot: snapshot)
  }
}

/// Zero percent is a real quota value, so presence—not magnitude—controls
/// whether a provider's plan-limit section is shown.
func hasReportedQuota(_ quota: QuotaSnapshotDTO) -> Bool {
  quota.primary != nil || quota.secondary != nil
}

/// A locally detected subscription proves that a plan exists, but never
/// supplies or estimates a usage percentage. Account metadata is therefore a
/// fallback label only when the fresh quota snapshot has no plan name.
func detectedAccountPlan(
  provider: String,
  snapshot: UsageSnapshotDTO
) -> String? {
  guard
    let account = snapshot.accounts?[provider],
    account.loggedIn
  else {
    return nil
  }
  return quotaPlanLabel(account.subscriptionType)
}

/// Plan providers include either a fresh official quota or a safely detected
/// subscription. This lets a first launch acknowledge Claude Max/Pro without
/// drawing a fictitious zero-percent meter.
func visiblePlanProviders(in snapshot: UsageSnapshotDTO) -> [String] {
  let quotaProviders = snapshot.quotas.compactMap { provider, quota in
    hasReportedQuota(quota) ? provider : nil
  }
  let accountProviders =
    snapshot.accounts?.compactMap {
      provider, _ in
      detectedAccountPlan(provider: provider, snapshot: snapshot) != nil
        ? provider : nil
    } ?? []
  return canonicalProviderOrder(
    Array(Set(quotaProviders).union(accountProviders))
  )
}

/// The three things someone glances at Tallyburn for: what is happening right
/// now, what has accumulated, and how much of a plan is left. Separating them
/// keeps each view quiet instead of stacking every metric into one column.
enum DashboardMode: String, CaseIterable, Identifiable {
  case now
  case history
  case limits

  var id: String { rawValue }

  /// A stable envelope for each instrument. Live snapshots can add or remove
  /// rows without moving the panel under the pointer; only an explicit mode
  /// change changes its height. Overflow remains available in the shared
  /// ScrollView.
  var panelHeight: CGFloat {
    switch self {
    case .now:
      return 620
    case .history:
      return 430
    case .limits:
      return 320
    }
  }

  var title: String {
    switch self {
    case .now:
      return localized("dashboard.mode.now", fallback: "Now")
    case .history:
      return localized("dashboard.mode.history", fallback: "History")
    case .limits:
      return localized("dashboard.mode.limits", fallback: "Limits")
    }
  }
}

/// The mutually exclusive token classes a composition strip can show, in the
/// order they are drawn.
enum TokenCompositionKind: CaseIterable {
  case context
  case cache
  case output
  case reasoning

  /// Categorical hues that only separate neighbouring slices. Every slice is
  /// labelled with its own name and percentage, so colour never carries the
  /// meaning on its own.
  var tint: Color {
    switch self {
    case .context: return .blue
    case .cache: return .teal
    case .output: return .orange
    case .reasoning: return .purple
    }
  }

  var title: String {
    switch self {
    case .context:
      return localized(
        "dashboard.composition.context",
        fallback: "Context"
      )
    case .cache:
      return localized(
        "dashboard.composition.cache",
        fallback: "Cache"
      )
    case .output:
      return localized(
        "dashboard.composition.output",
        fallback: "Output"
      )
    case .reasoning:
      return localized(
        "dashboard.composition.reasoning",
        fallback: "Reasoning"
      )
    }
  }
}

/// Splits one aggregate into non-overlapping display slices.
///
/// Providers that report reasoning do so *inside* `output`, so reasoning is
/// clamped into that range and then subtracted from the visible output slice
/// rather than counted twice. Percentages are taken against the sum of the
/// resulting slices, never against `total`, which also contains cache reads and
/// would make the strip add up to less than the whole.
struct TokenCompositionPresentation: Equatable {
  let context: Int64
  let cache: Int64
  let reasoning: Int64
  let output: Int64

  init(aggregate: ProviderAggregateDTO?) {
    guard let aggregate else {
      self.init(context: 0, cache: 0, reasoning: 0, output: 0)
      return
    }
    // Negative counts are malformed rather than meaningful, so they floor at
    // zero instead of subtracting from a neighbouring slice.
    let reportedOutput = max(0, aggregate.output)
    let countedReasoning = min(max(0, aggregate.reasoning), reportedOutput)
    self.init(
      context: max(0, aggregate.freshInput),
      cache: max(0, aggregate.cacheRead) + max(0, aggregate.cacheWrite),
      reasoning: countedReasoning,
      output: reportedOutput - countedReasoning
    )
  }

  init(context: Int64, cache: Int64, reasoning: Int64, output: Int64) {
    self.context = context
    self.cache = cache
    self.reasoning = reasoning
    self.output = output
  }

  func tokens(_ kind: TokenCompositionKind) -> Int64 {
    switch kind {
    case .context: return context
    case .cache: return cache
    case .reasoning: return reasoning
    case .output: return output
    }
  }

  /// The denominator every slice is measured against.
  var displayedTotal: Int64 {
    context + cache + reasoning + output
  }

  /// A zero denominator has no honest split, so the caller shows an
  /// unavailable state rather than an arbitrary or evenly divided strip.
  var isEmpty: Bool { displayedTotal <= 0 }

  func fraction(_ kind: TokenCompositionKind) -> Double {
    guard displayedTotal > 0 else { return 0 }
    return Double(tokens(kind)) / Double(displayedTotal)
  }

  /// Whole percentages that sum to exactly 100 whenever anything was measured.
  /// Remainders go to the largest fractional parts so a labelled strip never
  /// reads `33% 33% 33%`, and a slice that measured zero never inherits a
  /// percent it did not earn.
  func percentages() -> [TokenCompositionKind: Int] {
    let kinds = TokenCompositionKind.allCases
    guard displayedTotal > 0 else {
      return Dictionary(uniqueKeysWithValues: kinds.map { ($0, 0) })
    }

    let exact = kinds.map { fraction($0) * 100 }
    var whole = exact.map { Int($0) }
    var shortfall = 100 - whole.reduce(0, +)
    let remainders = zip(exact, whole).map { $0 - Double($1) }
    let candidates = kinds.indices
      .filter { tokens(kinds[$0]) > 0 }
      .sorted { remainders[$0] > remainders[$1] }

    var offset = 0
    while shortfall > 0, offset < candidates.count {
      whole[candidates[offset]] += 1
      shortfall -= 1
      offset += 1
    }

    return Dictionary(
      uniqueKeysWithValues: zip(kinds, whole).map { ($0, $1) }
    )
  }
}

/// Rounds a chart's top edge up to 1, 2, 5 × 10ⁿ so the axis lands on a number
/// a person can read rather than on the exact sample peak.
func niceScaleCeiling(_ value: Double) -> Double {
  guard value > 1 else { return 1 }
  let magnitude = pow(10, floor(log10(value)))
  let normalized = value / magnitude
  let ceiling: Double
  if normalized <= 1 {
    ceiling = 1
  } else if normalized <= 2 {
    ceiling = 2
  } else if normalized <= 5 {
    ceiling = 5
  } else {
    ceiling = 10
  }
  return ceiling * magnitude
}

/// Holds the vertical scale steady across one-second refreshes. The ceiling
/// grows immediately so a spike is never clipped, but only shrinks once the
/// peak has dropped below half of it — otherwise a sliding 60-second window
/// re-scales the whole graph every tick and the shape becomes unreadable.
func stableScaleCeiling(peak: Double, previous: Double) -> Double {
  let needed = niceScaleCeiling(max(peak, 1))
  if needed > previous { return needed }
  if peak <= previous / 2 { return needed }
  return previous
}

/// One real reported response, placed on the shared history timeline.
struct ProviderEventMark: Equatable {
  let provider: String
  /// Where the bucket sits in the history window, 0 (oldest) to 1 (now).
  let position: Double
  let tokens: Int64
}

/// Picks a restrained set of genuinely reported responses to mark on the live
/// chart.
///
/// Providers report at completed call boundaries, so a raw bucket with tokens
/// is a real event; marking every one of up to sixty buckets would be noise, so
/// each provider contributes only its heaviest buckets. Nothing is invented and
/// no token is spread across an assumed response duration.
func providerEventMarks(
  activity: LiveActivityDTO,
  providers: [String],
  perProvider: Int = 2
) -> [ProviderEventMark] {
  guard perProvider > 0 else { return [] }

  var marks: [ProviderEventMark] = []
  for provider in providers {
    guard let buckets = activity.series[provider], !buckets.isEmpty else {
      continue
    }
    let span = Double(buckets.count - 1)
    let heaviest = buckets.indices
      .filter { buckets[$0].tokens > 0 }
      .sorted { buckets[$0].tokens > buckets[$1].tokens }
      .prefix(perProvider)
    for index in heaviest {
      marks.append(
        ProviderEventMark(
          provider: provider,
          position: span > 0 ? Double(index) / span : 1,
          tokens: buckets[index].tokens
        )
      )
    }
  }
  return marks.sorted { $0.position < $1.position }
}

/// The window a glance should worry about: the verified one closest to its
/// limit. Returns nothing when the provider has no verified percentage, so a
/// detected-but-unmeasured plan can never reach the Now screen.
func mostConsumedVerifiedWindow(
  _ quota: QuotaSnapshotDTO
) -> QuotaWindowDTO? {
  [quota.primary, quota.secondary]
    .compactMap { $0 }
    .max { $0.usedPercent < $1.usedPercent }
}

/// Providers keep one order everywhere in the dashboard, so the rolling-usage
/// rows and the plan-limit groups never disagree about which provider comes
/// first. Providers the sidecar adds later follow alphabetically instead of
/// disappearing.
func canonicalProviderOrder(_ providers: [String]) -> [String] {
  let canonical = [
    "codex",
    "claude",
    "gemini",
    "copilot",
    "qwen",
    "ollama",
    "lmstudio",
    "llamacpp",
    "vllm",
  ]
  let known = canonical.filter(providers.contains)
  let extra = providers.filter { !canonical.contains($0) }.sorted()
  return known + extra
}

/// A short plan name such as `Pro` to sit beside a provider's plan limits.
/// Absent or blank plan types render nothing rather than an empty badge, so
/// the dashboard never implies a plan it has not observed.
func quotaPlanLabel(_ planType: String?) -> String? {
  guard
    let trimmed = planType?.trimmingCharacters(
      in: .whitespacesAndNewlines
    ),
    !trimmed.isEmpty
  else {
    return nil
  }
  return trimmed.capitalized
}

/// Display-ready values for a single plan-limit window, extracted so the
/// rounding, window labelling, and threshold colour can be unit tested apart
/// from the view.
struct QuotaWindowPresentation: Equatable {
  let compactWindow: String
  let usedPercent: Int
  let resetsAt: Double?

  init(window: QuotaWindowDTO) {
    compactWindow = Self.compactWindowLabel(window.windowMs)
    usedPercent = Int(window.usedPercent.rounded())
    resetsAt = window.resetsAt
  }

  var tint: Color { usageTint(Double(usedPercent)) }

  /// The meter tracks the same rounded number the label shows, clamped to the
  /// bar's range so an over-limit or malformed report cannot draw past the
  /// track or invert it.
  var meterValue: Double { min(max(Double(usedPercent), 0), 100) }

  /// A glanceable window label such as `5h` or `7d`.
  static func compactWindowLabel(_ milliseconds: Double) -> String {
    let hours = milliseconds / 3_600_000
    if hours >= 24, hours.truncatingRemainder(dividingBy: 24) == 0 {
      return "\(Int(hours / 24))d"
    }
    return "\(Int(hours.rounded()))h"
  }

  /// A spoken window phrase for VoiceOver, such as `7-day` or `5-hour`.
  static func spokenWindowLabel(_ milliseconds: Double) -> String {
    let hours = milliseconds / 3_600_000
    if hours >= 24, hours.truncatingRemainder(dividingBy: 24) == 0 {
      return localizedFormat(
        "dashboard.quota.window.days",
        fallback: "%d-day",
        Int(hours / 24)
      )
    }
    return localizedFormat(
      "dashboard.quota.window.hours",
      fallback: "%d-hour",
      Int(hours.rounded())
    )
  }
}

/// A small, consistent identity token reused wherever a provider is named, so
/// provider colour reinforces an adjacent name rather than standing in for it.
private struct ProviderSwatch: View {
  let name: String
  @Environment(\.providerColorOverrides) private var colorOverrides

  var body: some View {
    RoundedRectangle(cornerRadius: 2, style: .continuous)
      .fill(providerTint(name, overrides: colorOverrides))
      .frame(width: 8, height: 8)
      .accessibilityHidden(true)
  }
}

struct DashboardView: View {
  @ObservedObject var model: AppModel
  @Environment(\.openSettings) private var openSettings
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// View state, not a preference: a newly opened panel always starts on Now.
  @State private var mode: DashboardMode

  init(model: AppModel, initialMode: DashboardMode = .now) {
    self.model = model
    _mode = State(initialValue: initialMode)
  }

  private enum Layout {
    static let panelWidth: CGFloat = 390
    static let miniPanelWidth: CGFloat = 320
    static let compactPanelHeight: CGFloat = 420
    static let miniPanelHeight: CGFloat = 300
    static let modeTransitionDuration: TimeInterval = 0.18
    static let sparklineHeight: CGFloat = 38
    static let miniChartHeight: CGFloat = 72
  }

  var body: some View {
    Group {
      if model.hasMonitoringConsent {
        if model.miniMonitorEnabled {
          miniMonitor
        } else {
          fullMonitor
        }
      } else {
        onboarding
      }
    }
    .frame(width: panelWidth)
    // MenuBarExtra cannot derive a useful intrinsic height from ScrollView.
    // A discrete envelope per mode removes empty History/Limits space while
    // preventing one-second snapshot updates from resizing the panel.
    .frame(height: panelHeight, alignment: .top)
    .environment(\.providerColorOverrides, model.providerColors)
    .animation(
      reduceMotion
        ? nil
        : .easeInOut(duration: Layout.modeTransitionDuration),
      value: mode
    )
    .animation(
      reduceMotion
        ? nil
        : .easeInOut(duration: Layout.modeTransitionDuration),
      value: model.miniMonitorEnabled
    )
  }

  private var fullMonitor: some View {
    VStack(spacing: 0) {
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          dashboardContent
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .scrollBounceBehavior(.basedOnSize)

      Divider()
      footer
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }
  }

  private var onboarding: some View {
    ScrollView {
      OnboardingView(model: model)
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .scrollBounceBehavior(.basedOnSize)
  }

  private var panelWidth: CGFloat {
    model.hasMonitoringConsent && model.miniMonitorEnabled
      ? Layout.miniPanelWidth
      : Layout.panelWidth
  }

  private var panelHeight: CGFloat {
    guard model.hasMonitoringConsent else {
      return Layout.compactPanelHeight
    }
    if model.miniMonitorEnabled {
      return Layout.miniPanelHeight
    }
    guard model.snapshot != nil,
      model.selectedWindowSnapshot != nil
    else {
      return Layout.compactPanelHeight
    }
    return mode.panelHeight
  }

  private var miniMonitor: some View {
    VStack(spacing: 0) {
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          statusHeader
          miniDashboardContent
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .scrollBounceBehavior(.basedOnSize)

      Divider()
      footer
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
    }
  }

  private var statusHeader: some View {
    HStack {
      Label {
        Text(statusText)
          .foregroundStyle(.primary)
      } icon: {
        Image(systemName: statusIcon)
          .foregroundStyle(statusColor)
      }
      .font(.caption)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(
        localizedFormat(
          "dashboard.status.accessibility",
          fallback: "Status: %@",
          statusText
        )
      )

      Spacer()

      if let lastEventAt = model.lastObservedEventAt {
        Text(
          Date(timeIntervalSince1970: lastEventAt / 1_000),
          style: .relative
        )
        .font(.caption)
        .foregroundStyle(.secondary)
      }
    }
  }

  @ViewBuilder
  private var miniDashboardContent: some View {
    if let snapshot = model.snapshot,
      let window = model.selectedWindowSnapshot
    {
      MiniMonitorContent(
        model: model,
        snapshot: snapshot,
        window: window,
        chartHeight: Layout.miniChartHeight
      )
    } else if case .failed(let message) = model.state {
      VStack(alignment: .leading, spacing: 8) {
        Label(
          localized(
            "dashboard.monitoringUnavailable",
            fallback: "Monitoring unavailable"
          ),
          systemImage: "exclamationmark.triangle"
        )
        .foregroundStyle(.orange)

        Text(message)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(2)

        Button(
          localized(
            "dashboard.tryAgain",
            fallback: "Try Again"
          )
        ) {
          model.restart()
        }
        .buttonStyle(.borderedProminent)
      }
      .frame(maxWidth: .infinity, minHeight: 150, alignment: .center)
    } else {
      ProgressView(
        localized(
          "dashboard.starting",
          fallback: "Starting monitor…"
        )
      )
      .frame(maxWidth: .infinity, minHeight: 150)
    }
  }

  @ViewBuilder
  private var dashboardContent: some View {
    statusHeader

    if let snapshot = model.snapshot,
      let window = model.selectedWindowSnapshot
    {
      modePicker

      Group {
        switch mode {
        case .now:
          NowModeView(model: model, snapshot: snapshot, window: window)
        case .history:
          HistoryModeView(
            model: model,
            snapshot: snapshot,
            window: window,
            sparklineHeight: Layout.sparklineHeight
          )
        case .limits:
          LimitsModeView(snapshot: snapshot)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      // Reduce Motion callers get an instant swap; everyone else gets one
      // short cross-fade. Nothing animates on the one-second data refresh.
      .transition(reduceMotion ? .identity : .opacity)
      .animation(
        reduceMotion
          ? nil
          : .easeInOut(duration: Layout.modeTransitionDuration),
        value: mode
      )
    } else if case .failed(let message) = model.state {
      VStack(spacing: 12) {
        ContentUnavailableView(
          localized(
            "dashboard.monitoringUnavailable",
            fallback: "Monitoring unavailable"
          ),
          systemImage: "exclamationmark.triangle",
          description: Text(message)
        )

        HStack {
          Button(
            localized(
              "dashboard.tryAgain",
              fallback: "Try Again"
            )
          ) {
            model.restart()
          }
          .buttonStyle(.borderedProminent)

          Button(
            localized(
              "dashboard.openSettings",
              fallback: "Open Settings…"
            )
          ) {
            presentSettings()
          }
        }
      }
      .frame(maxWidth: .infinity, minHeight: 150)
    } else {
      ProgressView(
        localized(
          "dashboard.starting",
          fallback: "Starting monitor…"
        )
      )
      .frame(maxWidth: .infinity, minHeight: 120)
    }
  }

  /// Centred and intrinsically sized so the three words read as a quiet
  /// instrument label rather than a full-width toolbar.
  private var modePicker: some View {
    HStack {
      Spacer()
      Picker(
        localized("dashboard.mode", fallback: "View"),
        selection: $mode
      ) {
        ForEach(DashboardMode.allCases) { item in
          Text(item.title).tag(item)
        }
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .padding(.bottom, 8)
      .accessibilityLabel(
        localized("dashboard.mode", fallback: "View")
      )
      Spacer()
    }
  }

  private var footer: some View {
    HStack(spacing: 0) {
      Button(
        model.paused
          ? localized(
            "dashboard.resume",
            fallback: "Resume"
          )
          : localized(
            "dashboard.pause",
            fallback: "Pause"
          )
      ) {
        model.togglePause()
      }

      Spacer(minLength: 12)

      // Pause controls the running monitor. The view toggle and application
      // commands form two compact trailing groups instead of four evenly
      // scattered buttons, so proximity communicates their relationship.
      HStack(spacing: 12) {
        Button(
          model.miniMonitorEnabled
            ? localized(
              "dashboard.expandedMonitor",
              fallback: "Expanded"
            )
            : localized(
              "dashboard.miniMonitor",
              fallback: "Mini"
            )
        ) {
          model.setMiniMonitorEnabled(!model.miniMonitorEnabled)
        }
        .help(
          model.miniMonitorEnabled
            ? localized(
              "dashboard.expandedMonitor.help",
              fallback: "Switch to the expanded monitor"
            )
            : localized(
              "dashboard.miniMonitor.help",
              fallback: "Switch to the mini monitor"
            )
        )

        HStack(spacing: 6) {
          Button(
            localized(
              "dashboard.settings",
              fallback: "Settings…"
            )
          ) {
            presentSettings()
          }

          Button(
            localized(
              "dashboard.quit",
              fallback: "Quit"
            )
          ) {
            model.quit()
          }
        }
      }
    }
    .controlSize(.small)
  }

  private func presentSettings() {
    openSettings()

    // Menu-bar-only apps do not always become active when SwiftUI creates
    // their Settings scene. Activate after the window has been ordered in.
    DispatchQueue.main.async {
      NSApplication.shared.activate(ignoringOtherApps: true)
    }
  }

  private var statusText: String {
    switch model.state {
    case .idle:
      return localized("dashboard.status.idle", fallback: "Idle")
    case .starting:
      return localized(
        "dashboard.status.connecting",
        fallback: "Connecting"
      )
    case .connected:
      return model.isCurrentlyReportingActivity
        ? localized(
          "dashboard.status.reportedActivity",
          fallback: "Reported activity"
        )
        : localized(
          "dashboard.status.listening",
          fallback: "Listening"
        )
    case .paused:
      return localized("dashboard.status.paused", fallback: "Paused")
    case .failed:
      return localized(
        "dashboard.status.needsAttention",
        fallback: "Needs attention"
      )
    }
  }

  private var statusIcon: String {
    switch model.state {
    case .connected: return "circle.fill"
    case .starting: return "circle.dotted"
    case .failed: return "exclamationmark.circle.fill"
    case .paused: return "pause.circle.fill"
    case .idle: return "circle"
    }
  }

  private var statusColor: Color {
    switch model.state {
    case .connected: return .green
    case .failed: return .orange
    default: return .secondary
    }
  }
}

/// The same one-minute instrument reduced to a glanceable menu-bar panel.
/// It keeps the measured rate, timeline, provider identity, and selected
/// rolling total while leaving configuration and quota detail to Expanded.
private struct MiniMonitorContent: View {
  @ObservedObject var model: AppModel
  let snapshot: UsageSnapshotDTO
  let window: WindowAggregateDTO
  let chartHeight: CGFloat

  private var visibleProviders: [String] {
    Array(observedProviders(in: snapshot).prefix(3))
  }

  private var averageWindowMs: Double {
    snapshot.liveActivity?.rateWindowMs
      ?? snapshot.liveRate?.trailingWindowMs
      ?? snapshot.recentRateWindowMs
      ?? 60_000
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        VStack(alignment: .leading, spacing: 1) {
          HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(
              model.menuAverageTokensPerSecond.map(formatRateValue) ?? "—"
            )
            .font(
              .system(size: 36, weight: .light, design: .rounded)
            )
            .monospacedDigit()

            Text(
              localized(
                "unit.tokensPerSecond.short",
                fallback: "tok/s"
              )
            )
            .font(.caption)
            .foregroundStyle(.secondary)
          }

          Text(
            localizedFormat(
              "dashboard.now.movingAverage",
              fallback: "%@ moving average",
              formatRateWindow(averageWindowMs)
            )
          )
          .font(.caption2)
          .foregroundStyle(.secondary)
        }

        Spacer(minLength: 8)

        VStack(alignment: .trailing, spacing: 1) {
          Text(window.label)
            .font(.caption2)
            .foregroundStyle(.secondary)
          Text(formatCompact(window.all.total))
            .font(.title3)
            .monospacedDigit()
        }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(model.accessibilityLabel)

      if let activity = snapshot.liveActivity {
        VStack(spacing: 2) {
          LiveActivityChart(
            activity: activity,
            currentRate: model.currentReportedTokensPerSecond,
            marks: providerEventMarks(
              activity: activity,
              providers: observedProviders(in: snapshot),
              perProvider: 1
            )
          )
          .frame(height: chartHeight)

          HStack {
            Text(
              localizedFormat(
                "dashboard.time.ago",
                fallback: "%@ ago",
                formatRateWindow(activity.historyWindowMs)
              )
            )
            Spacer()
            Text(localized("dashboard.time.now", fallback: "Now"))
          }
          .font(.caption2)
          .foregroundStyle(.tertiary)
        }
      } else {
        MiniChartPlaceholder(height: chartHeight)
      }

      if !visibleProviders.isEmpty {
        HStack(alignment: .top, spacing: 0) {
          ForEach(visibleProviders.indices, id: \.self) { index in
            if index > 0 {
              Divider().frame(height: 34)
            }
            miniProvider(visibleProviders[index])
          }
        }
      }
    }
  }

  private func miniProvider(_ provider: String) -> some View {
    let rate = model.reportedTokensPerSecond(for: provider)
    let value = localizedFormat(
      "unit.perSecond.compact",
      fallback: "%@/s",
      rate.map(formatRateValue) ?? "—"
    )

    return VStack(spacing: 1) {
      HStack(spacing: 4) {
        ProviderSwatch(name: provider)
        Text(providerDisplayName(provider))
          .lineLimit(1)
          .minimumScaleFactor(0.75)
      }
      .font(.caption2)
      .foregroundStyle(.secondary)

      Text(value)
        .font(.callout)
        .monospacedDigit()
        .lineLimit(1)
        .minimumScaleFactor(0.75)
    }
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(
      localizedFormat(
        "dashboard.glance.provider.accessibility",
        fallback: "%1$@ %2$@",
        providerDisplayName(provider),
        value
      )
    )
  }
}

private struct MiniChartPlaceholder: View {
  let height: CGFloat

  var body: some View {
    GeometryReader { geometry in
      ZStack {
        Path { path in
          for index in 1..<4 {
            let x = geometry.size.width * CGFloat(index) / 4
            path.move(to: CGPoint(x: x, y: 0))
            path.addLine(
              to: CGPoint(x: x, y: geometry.size.height)
            )
          }
          for index in 1..<3 {
            let y = geometry.size.height * CGFloat(index) / 3
            path.move(to: CGPoint(x: 0, y: y))
            path.addLine(
              to: CGPoint(x: geometry.size.width, y: y)
            )
          }
        }
        .stroke(
          Color.primary.opacity(0.065),
          style: StrokeStyle(lineWidth: 0.5)
        )

        Text(
          localized(
            "liveActivity.historyUnavailable",
            fallback: "Live history unavailable"
          )
        )
        .font(.caption)
        .foregroundStyle(.secondary)
      }
    }
    .frame(height: height)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(
      localized(
        "liveActivity.historyUnavailable",
        fallback: "Live history unavailable"
      )
    )
  }
}

/// The calm instrument: one isolated headline, one stable graph, and three
/// supporting glances. Everything here is a measured value or an honest blank.
private struct NowModeView: View {
  @ObservedObject var model: AppModel
  let snapshot: UsageSnapshotDTO
  let window: WindowAggregateDTO

  @ScaledMetric(relativeTo: .largeTitle) private var headlineSize: CGFloat =
    68
  @ScaledMetric(relativeTo: .body) private var chartHeight: CGFloat = 126

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      if let activity = snapshot.liveActivity {
        headline(activity: activity)

        VStack(spacing: 4) {
          LiveActivityChart(
            activity: activity,
            currentRate: model.currentReportedTokensPerSecond,
            marks: providerEventMarks(
              activity: activity,
              providers: observedProviders(in: snapshot)
            )
          )
          .frame(height: chartHeight)

          HStack {
            Text(
              localizedFormat(
                "dashboard.time.ago",
                fallback: "%@ ago",
                formatRateWindow(activity.historyWindowMs)
              )
            )
            Spacer()
            Text(localized("dashboard.time.now", fallback: "Now"))
          }
          .font(.caption2)
          .foregroundStyle(.secondary)
        }
      } else {
        LegacyPacePanel(model: model)
      }

      GlanceRow(model: model, snapshot: snapshot, window: window)

      TokenCompositionStrip(
        composition: TokenCompositionPresentation(
          aggregate: window.all
        ),
        windowLabel: window.label
      )

      quotaPreview
    }
  }

  /// The one number worth reading from across a desk, with its basis stated
  /// directly underneath so the value is never mistaken for streaming speed.
  private func headline(activity: LiveActivityDTO) -> some View {
    VStack(spacing: 4) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text(
          model.currentReportedTokensPerSecond.map(formatRateValue) ?? "—"
        )
        .font(
          .system(size: headlineSize, weight: .light, design: .rounded)
        )
        .monospacedDigit()
        .foregroundStyle(
          model.currentReportedTokensPerSecond == nil
            ? AnyShapeStyle(.secondary)
            : AnyShapeStyle(.primary)
        )

        Text(
          localized("unit.tokensPerSecond.short", fallback: "tok/s")
        )
        .font(.title3)
        .foregroundStyle(.secondary)
      }

      HStack(spacing: 4) {
        Text(headlineCaption(activity: activity))
          .font(.callout)
          .foregroundStyle(.secondary)

        InfoPopoverButton(
          label: localized(
            "dashboard.liveActivity.info",
            fallback: "About completed-response activity"
          ),
          text: model.liveActivityHelp
        )
      }
    }
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .contain)
  }

  /// A live non-zero rate states its basis; anything else defers to the
  /// model's caption, which already distinguishes a measured zero from a
  /// stale or disconnected reading.
  private func headlineCaption(activity: LiveActivityDTO) -> String {
    guard let rate = model.currentReportedTokensPerSecond, rate > 0 else {
      return model.liveActivityCaption
    }
    return localizedFormat(
      "dashboard.now.movingAverage",
      fallback: "%@ moving average",
      formatRateWindow(activity.rateWindowMs)
    )
  }

  /// Only verified percentages surface here, one line per provider. A detected
  /// plan with no measured usage stays in Limits, where it can be explained.
  @ViewBuilder
  private var quotaPreview: some View {
    let previewProviders = canonicalProviderOrder(
      Array(snapshot.quotas.keys)
    )
    .filter { provider in
      guard let quota = snapshot.quotas[provider] else { return false }
      return hasReportedQuota(quota)
        && mostConsumedVerifiedWindow(quota) != nil
    }

    if !previewProviders.isEmpty {
      Divider()
      VStack(alignment: .leading, spacing: 6) {
        ForEach(previewProviders, id: \.self) { provider in
          if let quota = snapshot.quotas[provider],
            let best = mostConsumedVerifiedWindow(quota)
          {
            QuotaPreviewRow(provider: provider, window: best)
          }
        }
      }
    }
  }
}

/// Three plain numbers under the graph: the selected rolling total, then each
/// observed provider's current rate. Providers absent from the data are absent
/// here too.
private struct GlanceRow: View {
  @ObservedObject var model: AppModel
  let snapshot: UsageSnapshotDTO
  let window: WindowAggregateDTO
  @Environment(\.providerColorOverrides) private var colorOverrides

  var body: some View {
    let providers = observedProviders(in: snapshot)

    HStack(alignment: .top, spacing: 0) {
      glance(
        label: window.label,
        value: formatCompact(window.all.total),
        accessibilityLabel: localizedFormat(
          "dashboard.glance.window.accessibility",
          fallback: "Last %@ total %@ tokens",
          window.label,
          formatCompact(window.all.total)
        )
      )

      ForEach(providers, id: \.self) { provider in
        Divider().frame(height: 44)
        glance(
          label: providerDisplayName(provider),
          value: providerRateText(provider),
          swatch: provider,
          accessibilityLabel: localizedFormat(
            "dashboard.glance.provider.accessibility",
            fallback: "%@ %@",
            providerDisplayName(provider),
            providerRateText(provider)
          )
        )
      }
    }
  }

  /// A provider present in the live record but silent right now reads as a
  /// measured zero; one that reports no rate at all reads as unavailable.
  private func providerRateText(_ provider: String) -> String {
    guard let rate = model.reportedTokensPerSecond(for: provider) else {
      return "—"
    }
    return localizedFormat(
      "unit.perSecond.compact",
      fallback: "%@/s",
      formatRateValue(rate)
    )
  }

  private func glance(
    label: String,
    value: String,
    swatch: String? = nil,
    accessibilityLabel: String
  ) -> some View {
    VStack(spacing: 2) {
      HStack(spacing: 5) {
        if let swatch {
          Circle()
            .fill(providerTint(swatch, overrides: colorOverrides))
            .frame(width: 7, height: 7)
            .accessibilityHidden(true)
        }
        Text(label)
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      Text(value)
        .font(.system(size: 22, weight: .regular))
        .monospacedDigit()
        .lineLimit(1)
        .minimumScaleFactor(0.7)
    }
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityLabel)
  }
}

/// A thin strip showing where the window's tokens went. Slices are mutually
/// exclusive, so the bar and its four labels describe the same whole.
private struct TokenCompositionStrip: View {
  let composition: TokenCompositionPresentation
  let windowLabel: String

  @ScaledMetric(relativeTo: .caption2) private var barHeight: CGFloat = 7

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if composition.isEmpty {
        Capsule()
          .fill(.quaternary)
          .frame(height: barHeight)

        Text(
          localized(
            "dashboard.composition.unavailable",
            fallback: "No token composition measured yet"
          )
        )
        .font(.caption)
        .foregroundStyle(.secondary)
      } else {
        let percentages = composition.percentages()

        GeometryReader { geometry in
          HStack(spacing: 0) {
            ForEach(TokenCompositionKind.allCases, id: \.self) { kind in
              Rectangle()
                .fill(kind.tint)
                .frame(
                  width: max(
                    0,
                    geometry.size.width * composition.fraction(kind)
                  )
                )
            }
          }
        }
        .frame(height: barHeight)
        .clipShape(Capsule())

        HStack(alignment: .top, spacing: 0) {
          ForEach(TokenCompositionKind.allCases, id: \.self) { kind in
            VStack(spacing: 1) {
              Text(kind.title)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)

              Text("\(percentages[kind] ?? 0)%")
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(kind.tint)
            }
            .frame(maxWidth: .infinity)
          }
        }
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(
      localizedFormat(
        "dashboard.composition.accessibilityLabel",
        fallback: "Token composition for the last %@",
        windowLabel
      )
    )
    .accessibilityValue(accessibilityValue)
  }

  private var accessibilityValue: String {
    guard !composition.isEmpty else {
      return localized(
        "dashboard.composition.unavailable",
        fallback: "No token composition measured yet"
      )
    }
    let percentages = composition.percentages()
    return TokenCompositionKind.allCases
      .map { kind in
        localizedFormat(
          "dashboard.composition.slice.accessibility",
          fallback: "%1$@ %2$d percent",
          kind.title,
          percentages[kind] ?? 0
        )
      }
      .joined(separator: ", ")
  }
}

/// The Now screen's single quota line: provider, window, meter, percentage and
/// countdown, all on one row.
private struct QuotaPreviewRow: View {
  let provider: String
  let window: QuotaWindowDTO

  @ScaledMetric(relativeTo: .caption) private var percentWidth: CGFloat = 40
  @ScaledMetric(relativeTo: .caption2) private var resetWidth: CGFloat = 74

  var body: some View {
    let presentation = QuotaWindowPresentation(window: window)

    HStack(alignment: .firstTextBaseline, spacing: 8) {
      HStack(spacing: 6) {
        ProviderSwatch(name: provider)
        Text(providerDisplayName(provider))
          .font(.callout)
        Text(presentation.compactWindow)
          .font(.caption)
          .monospacedDigit()
          .foregroundStyle(.secondary)
      }

      ProgressView(value: presentation.meterValue, total: 100)
        .tint(presentation.tint)

      Text("\(presentation.usedPercent)%")
        .font(.caption)
        .monospacedDigit()
        .foregroundStyle(presentation.tint)
        .frame(width: percentWidth, alignment: .trailing)

      if window.resetsAt != nil {
        Text(resetDate, style: .relative)
          .font(.caption2)
          .monospacedDigit()
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .minimumScaleFactor(0.8)
          .frame(width: resetWidth, alignment: .trailing)
          .help(
            localizedFormat(
              "dashboard.quota.resetsAt",
              fallback: "Resets %@",
              resetDate.formatted(date: .abbreviated, time: .shortened)
            )
          )
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(
      localizedFormat(
        "dashboard.quota.accessibility",
        fallback: "%@ %@ limit, %d percent used",
        providerDisplayName(provider),
        QuotaWindowPresentation.spokenWindowLabel(window.windowMs),
        presentation.usedPercent
      ) + resetAccessibilityPhrase
    )
  }

  private var resetDate: Date {
    Date(timeIntervalSince1970: (window.resetsAt ?? 0) / 1_000)
  }

  private var resetAccessibilityPhrase: String {
    guard window.resetsAt != nil else { return "" }
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .full
    return localizedFormat(
      "dashboard.quota.accessibility.resets",
      fallback: " Resets %@.",
      formatter.localizedString(for: resetDate, relativeTo: Date())
    )
  }
}

/// Everything accumulated: the configurable rolling window, its graph, its
/// total, and the per-provider breakdown.
private struct HistoryModeView: View {
  @ObservedObject var model: AppModel
  let snapshot: UsageSnapshotDTO
  let window: WindowAggregateDTO
  let sparklineHeight: CGFloat

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .firstTextBaseline) {
          Text(
            localized(
              "dashboard.rollingUsage",
              fallback: "Rolling usage"
            )
          )
          .font(.caption.weight(.medium))
          .foregroundStyle(.secondary)
          .accessibilityAddTraits(.isHeader)

          Spacer()

          Text(
            localizedFormat(
              "dashboard.rollingUsage.summary",
              fallback: "Last %@ · %@",
              model.selectedWindow,
              formatCompact(window.all.total)
            )
          )
          .font(.caption)
          .monospacedDigit()
        }

        Picker(
          localized("dashboard.window", fallback: "Window"),
          selection: Binding(
            get: { model.selectedWindow },
            set: { model.setSelectedWindow($0) }
          )
        ) {
          ForEach(snapshot.windows) { item in
            Text(item.label).tag(item.label)
          }
        }
        .pickerStyle(.segmented)
        .labelsHidden()

        SparklineView(
          points:
            snapshot.seriesByWindow?[model.selectedWindow]?["all"]
            ?? snapshot.series["all"]
            ?? [],
          windowLabel: model.selectedWindow,
          aggregateTotal: window.all.total
        )
        .frame(height: sparklineHeight)
      }

      let visibleProviders = observedProviders(in: snapshot)

      if !visibleProviders.isEmpty {
        VStack(spacing: 8) {
          ForEach(visibleProviders, id: \.self) { provider in
            ProviderRow(
              name: providerDisplayName(provider),
              aggregate: window.providers[provider],
              tokensPerSecond:
                model.reportedTokensPerSecond(for: provider),
              pace: model.observedPace(for: provider),
              total: window.all.total,
              windowLabel: model.selectedWindow
            )
          }
        }
      }
    }
  }
}

/// Plan limits, including a detected subscription that has no verified
/// percentage yet.
private struct LimitsModeView: View {
  let snapshot: UsageSnapshotDTO

  var body: some View {
    let providers = visiblePlanProviders(in: snapshot)

    VStack(alignment: .leading, spacing: 10) {
      Text(localized("dashboard.planLimits", fallback: "Plan limits"))
        .font(.caption.weight(.medium))
        .foregroundStyle(.secondary)
        .accessibilityAddTraits(.isHeader)

      if providers.isEmpty {
        Text(
          localized(
            "dashboard.planLimits.unavailable",
            fallback:
              "No plan limits reported yet. Tallyburn shows a percentage only when a provider publishes one."
          )
        )
        .font(.callout)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      } else {
        ForEach(providers, id: \.self) { provider in
          if let quota = snapshot.quotas[provider],
            hasReportedQuota(quota)
          {
            QuotaRow(
              provider: provider,
              quota: quota,
              detectedPlanType: detectedAccountPlan(
                provider: provider,
                snapshot: snapshot
              )
            )
          } else if let plan = detectedAccountPlan(
            provider: provider,
            snapshot: snapshot
          ) {
            DetectedPlanRow(provider: provider, planType: plan)
          }
        }
      }
    }
  }
}

private struct LegacyPacePanel: View {
  @ObservedObject var model: AppModel

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack {
        Text(
          localized(
            "dashboard.observedPace",
            fallback: "Observed pace"
          )
        )
        .font(.caption.weight(.medium))
        .foregroundStyle(.secondary)
        .accessibilityAddTraits(.isHeader)

        InfoPopoverButton(
          label: localized(
            "dashboard.observedPace.info",
            fallback: "About observed pace"
          ),
          text: model.observedPaceHelp
        )

        Spacer()

        Text(model.observedPaceCaption)
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
      HStack(alignment: .firstTextBaseline, spacing: 4) {
        Text(model.currentObservedPace.map(formatCompact) ?? "—")
          .font(
            .system(
              size: 32,
              weight: .semibold,
              design: .rounded
            )
          )
          .monospacedDigit()
          .foregroundStyle(
            model.currentObservedPace == nil
              ? AnyShapeStyle(.secondary)
              : AnyShapeStyle(.primary)
          )

        Text(
          localized(
            "unit.perMinute.short",
            fallback: "/min"
          )
        )
        .font(.headline)
        .foregroundStyle(.secondary)
      }
    }
  }
}

private struct InfoPopoverButton: View {
  let label: String
  let text: String
  @State private var isPresented = false

  var body: some View {
    Button {
      isPresented.toggle()
    } label: {
      Image(systemName: "info.circle")
        .font(.caption2)
        .foregroundStyle(.secondary)
    }
    .buttonStyle(.plain)
    .help(label)
    .accessibilityLabel(label)
    .accessibilityHint(
      localized(
        "dashboard.info.hint",
        fallback: "Shows calculation details"
      )
    )
    .popover(isPresented: $isPresented, arrowEdge: .bottom) {
      Text(text)
        .font(.callout)
        .textSelection(.enabled)
        .frame(width: 310, alignment: .leading)
        .padding()
    }
  }
}

private struct OnboardingView: View {
  @ObservedObject var model: AppModel

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Image(systemName: "flame.fill")
        .font(.title)
        .foregroundStyle(.orange)
        .accessibilityHidden(true)

      Text(
        localized(
          "onboarding.title",
          fallback: "Choose how Tallyburn observes usage"
        )
      )
      .font(.headline)

      Text(
        localized(
          "onboarding.privacy",
          fallback:
            "No Tallyburn account or additional provider login is required. Tallyburn never opens credentials or stores prompts; it keeps only numeric usage and plan labels from supported local logs and official client status."
        )
      )
      .font(.callout)
      .foregroundStyle(.secondary)

      Button(MonitoringMode.standard.title) {
        model.enableMonitoring(.standard)
      }
      .buttonStyle(.borderedProminent)

      Button(MonitoringMode.metricsOnly.title) {
        model.enableMonitoring(.metricsOnly)
      }
      .buttonStyle(.bordered)

      Button(
        localized(
          "onboarding.demo",
          fallback: "Preview with demo data"
        )
      ) {
        model.enableMonitoring(.demo)
      }
      .buttonStyle(.plain)
    }
  }
}

private struct ProviderRow: View {
  let name: String
  let aggregate: ProviderAggregateDTO?
  let tokensPerSecond: Double?
  let pace: Int64?
  let total: Int64
  let windowLabel: String
  @Environment(\.providerColorOverrides) private var colorOverrides

  private var isLive: Bool {
    tokensPerSecond != nil || pace != nil
  }

  var body: some View {
    VStack(spacing: 3) {
      HStack(alignment: .firstTextBaseline) {
        HStack(spacing: 7) {
          ProviderSwatch(name: name)
          Text(name)
        }
        Spacer()
        VStack(alignment: .trailing, spacing: 1) {
          Text(rateText)
            .monospacedDigit()
            .foregroundStyle(
              isLive
                ? AnyShapeStyle(.primary)
                : AnyShapeStyle(.secondary)
            )

          Text(detailText)
            .font(.caption2)
            .foregroundStyle(.secondary)
            .monospacedDigit()
        }
      }
      ProgressView(
        value: total > 0 ? Double(value) : 0,
        total: total > 0 ? Double(total) : 1
      )
      // macOS draws a rounded leading cap even at zero. Make that cap
      // transparent so a true zero cannot look like a small non-zero share.
      .tint(
        value > 0
          ? providerTint(name, overrides: colorOverrides)
          : .clear
      )
      .accessibilityHidden(true)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(name)
    .accessibilityValue(accessibilityValue)
  }

  private var value: Int64 {
    aggregate?.total ?? 0
  }

  private var rateText: String {
    if let tokensPerSecond {
      return localizedFormat(
        "unit.tokensPerSecond.compact",
        fallback: "%@ tok/s",
        formatRateValue(tokensPerSecond)
      )
    }
    if let pace {
      return localizedFormat(
        "unit.tokensPerMinute.compact",
        fallback: "%@/min",
        formatCompact(pace)
      )
    }
    return localized(
      "dashboard.rateUnavailable",
      fallback: "Rate unavailable"
    )
  }

  private var detailText: String {
    if tokensPerSecond != nil {
      return localizedFormat(
        "dashboard.provider.detail.total",
        fallback: "%@ total · %@",
        windowLabel,
        formatCompact(value)
      )
    }
    if let pace {
      return localizedFormat(
        "dashboard.provider.detail.live",
        fallback: "60s %@/min · %@ %@",
        formatCompact(pace),
        windowLabel,
        formatCompact(value)
      )
    }
    return localizedFormat(
      "dashboard.provider.detail.total",
      fallback: "%@ total · %@",
      windowLabel,
      formatCompact(value)
    )
  }

  private var accessibilityValue: String {
    localizedFormat(
      "dashboard.provider.accessibility",
      fallback: "%@. Last %@ total %@ tokens.",
      rateText,
      windowLabel,
      formatCompact(value)
    )
  }
}

private struct QuotaRow: View {
  let provider: String
  let quota: QuotaSnapshotDTO
  let detectedPlanType: String?

  /// Aligns the window meters under the provider name rather than under its
  /// swatch, so the group reads as a hierarchy instead of a flat list.
  @ScaledMetric(relativeTo: .callout) private var indent: CGFloat = 15

  private var windows: [QuotaWindowDTO] {
    [quota.primary, quota.secondary].compactMap { $0 }
  }

  /// One provider's windows share a reset column so their meters stay aligned,
  /// and a provider whose source reports no reset time spends no width on it.
  private var reservesResetColumn: Bool {
    windows.contains { $0.resetsAt != nil }
  }

  private var planLabel: String? {
    quotaPlanLabel(quota.planType) ?? quotaPlanLabel(detectedPlanType)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 7) {
        ProviderSwatch(name: provider)
        Text(providerDisplayName(provider))
          .font(.callout.weight(.medium))

        Spacer()

        if let plan = planLabel {
          Text(plan)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityAddTraits(.isHeader)
      .accessibilityLabel(headerAccessibilityLabel)

      VStack(alignment: .leading, spacing: 4) {
        ForEach(Array(windows.enumerated()), id: \.offset) { item in
          QuotaWindowRow(
            provider: provider,
            window: item.element,
            reservesResetColumn: reservesResetColumn
          )
        }
      }
      .padding(.leading, indent)
    }
  }

  private var headerAccessibilityLabel: String {
    guard let plan = planLabel else {
      return providerDisplayName(provider)
    }
    return localizedFormat(
      "dashboard.quota.plan.accessibility",
      fallback: "%@, %@ plan",
      providerDisplayName(provider),
      plan
    )
  }
}

/// Subscription discovery is intentionally meter-free: it proves the plan is
/// available without implying that the latest 5h/7d usage is known.
private struct DetectedPlanRow: View {
  let provider: String
  let planType: String

  @ScaledMetric(relativeTo: .callout) private var indent: CGFloat = 15

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 7) {
        ProviderSwatch(name: provider)
        Text(providerDisplayName(provider))
          .font(.callout.weight(.medium))

        Spacer()

        Text(planType)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      .accessibilityElement(children: .ignore)
      .accessibilityAddTraits(.isHeader)
      .accessibilityLabel(
        localizedFormat(
          "dashboard.quota.plan.accessibility",
          fallback: "%@, %@ plan",
          providerDisplayName(provider),
          planType
        )
      )

      HStack(spacing: 5) {
        Label(
          localized(
            "dashboard.plan.detected",
            fallback: "Plan detected"
          ),
          systemImage: "checkmark.circle.fill"
        )
        .foregroundStyle(.secondary)

        Spacer()

        Text(
          localized(
            "dashboard.plan.usageUnverified",
            fallback: "Usage unverified"
          )
        )
        .foregroundStyle(.secondary)
      }
      .font(.caption)
      .padding(.leading, indent)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(
        localizedFormat(
          "dashboard.plan.detected.accessibility",
          fallback:
            "%@, %@ plan detected. Usage percentage unavailable.",
          providerDisplayName(provider),
          planType
        )
      )
      .accessibilityHint(
        localized(
          "dashboard.plan.detected.hint",
          fallback:
            "Usage appears after Claude Code reports fresh plan limits."
        )
      )
    }
  }
}

private struct QuotaWindowRow: View {
  let provider: String
  let window: QuotaWindowDTO
  let reservesResetColumn: Bool

  // Text-relative so the columns keep their contents at larger system text
  // sizes instead of truncating a three-glyph label or `100%`.
  @ScaledMetric(relativeTo: .caption) private var labelWidth: CGFloat = 26
  @ScaledMetric(relativeTo: .caption) private var percentWidth: CGFloat = 40
  @ScaledMetric(relativeTo: .caption2) private var resetWidth: CGFloat = 66

  var body: some View {
    let presentation = QuotaWindowPresentation(window: window)
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(presentation.compactWindow)
        .font(.caption.weight(.medium))
        .monospacedDigit()
        .foregroundStyle(.secondary)
        .frame(width: labelWidth, alignment: .leading)

      ProgressView(value: presentation.meterValue, total: 100)
        .tint(presentation.tint)

      Text("\(presentation.usedPercent)%")
        .font(.caption)
        .monospacedDigit()
        .foregroundStyle(presentation.tint)
        .frame(width: percentWidth, alignment: .trailing)

      if reservesResetColumn {
        resetIndicator
          .frame(width: resetWidth, alignment: .trailing)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(
      localizedFormat(
        "dashboard.quota.accessibility",
        fallback: "%@ %@ limit, %d percent used",
        providerDisplayName(provider),
        QuotaWindowPresentation.spokenWindowLabel(window.windowMs),
        presentation.usedPercent
      ) + resetAccessibilityPhrase
    )
  }

  /// The countdown sits on the meter row rather than on a line of its own: it
  /// keeps each window to one line, and the refresh glyph is unambiguous next
  /// to the meter it renews.
  @ViewBuilder
  private var resetIndicator: some View {
    if window.resetsAt != nil {
      HStack(spacing: 2) {
        Image(systemName: "arrow.clockwise")
          .imageScale(.small)
        Text(resetDate, style: .relative)
          .monospacedDigit()
          .lineLimit(1)
          .minimumScaleFactor(0.8)
      }
      .font(.caption2)
      .foregroundStyle(.secondary)
      .help(
        localizedFormat(
          "dashboard.quota.resetsAt",
          fallback: "Resets %@",
          resetDate.formatted(date: .abbreviated, time: .shortened)
        )
      )
    }
  }

  private var resetDate: Date {
    Date(timeIntervalSince1970: (window.resetsAt ?? 0) / 1_000)
  }

  private var resetAccessibilityPhrase: String {
    guard window.resetsAt != nil else { return "" }
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .full
    return localizedFormat(
      "dashboard.quota.accessibility.resets",
      fallback: " Resets %@.",
      formatter.localizedString(for: resetDate, relativeTo: Date())
    )
  }
}

private struct LiveActivityChart: View {
  let activity: LiveActivityDTO
  let currentRate: Double?
  var marks: [ProviderEventMark] = []
  @Environment(\.providerColorOverrides) private var colorOverrides

  /// Carried across refreshes so the vertical scale does not jump every second.
  @State private var ceiling: Double = 1

  private var fallbackRawRates: [Double] {
    let seconds = max(activity.sampleIntervalMs / 1_000, 0.001)
    return (activity.series["all"] ?? []).map {
      Double($0.tokens) / seconds
    }
  }

  private var displayedRates: [Double] {
    let rates = activity.rateSeries?["all"]?.map(\.tokensPerSecond) ?? []
    return rates.isEmpty ? fallbackRawRates : rates
  }

  var body: some View {
    GeometryReader { geometry in
      let rates = displayedRates
      let peak = max(ceiling, 1)
      let plotSize = geometry.size

      ZStack {
        activityGrid(size: plotSize)
          .stroke(
            Color.primary.opacity(0.065),
            style: StrokeStyle(lineWidth: 0.5)
          )
          .accessibilityHidden(true)

        activityArea(
          values: rates,
          peak: peak,
          size: plotSize
        )
        .fill(
          LinearGradient(
            colors: [
              Color.accentColor.opacity(0.26),
              Color.accentColor.opacity(0.02),
            ],
            startPoint: .top,
            endPoint: .bottom
          )
        )

        activityLine(
          values: rates,
          peak: peak,
          size: plotSize
        )
        .stroke(
          Color.accentColor.opacity(0.88),
          style: StrokeStyle(
            lineWidth: 1.3,
            lineJoin: .round
          )
        )

        // Each dot is one provider's heaviest reported bucket in this window,
        // sitting on the rate line at the moment it was reported.
        ForEach(marks.indices, id: \.self) { index in
          let mark = marks[index]
          Circle()
            .fill(
              providerTint(mark.provider, overrides: colorOverrides)
            )
            .frame(width: 6, height: 6)
            .position(
              markPoint(
                mark,
                values: rates,
                peak: peak,
                size: plotSize
              )
            )
        }
      }
      .opacity(currentRate == nil ? 0.45 : 1)
      .overlay {
        if currentRate == nil {
          Text(
            localized(
              "dashboard.lastKnown",
              fallback: "Last known"
            )
          )
          .font(.caption)
          .foregroundStyle(.secondary)
          .padding(.horizontal, 8)
          .padding(.vertical, 4)
          .background(.regularMaterial, in: Capsule())
        }
      }
      .onAppear { updateCeiling(rates) }
      .onChange(of: rates.max() ?? 0) { _, _ in updateCeiling(rates) }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(
      localizedFormat(
        "dashboard.chart.accessibilityLabel",
        fallback: "Reported token activity over the last %@",
        formatRateWindow(activity.historyWindowMs)
      )
    )
    .accessibilityValue(accessibilityValue)
  }

  /// Six time bands suggest ten-second intervals across the one-minute plot,
  /// while four value bands give an idle chart enough structure without
  /// competing with the activity line. Only interior hairlines are drawn so
  /// the chart does not read as a boxed table.
  private func activityGrid(size: CGSize) -> Path {
    let timeBands = 6
    let valueBands = 4
    return Path { path in
      guard size.width > 0, size.height > 0 else { return }

      for index in 1..<timeBands {
        let x = size.width * CGFloat(index) / CGFloat(timeBands)
        path.move(to: CGPoint(x: x, y: 0))
        path.addLine(to: CGPoint(x: x, y: size.height))
      }

      for index in 1..<valueBands {
        let y = size.height * CGFloat(index) / CGFloat(valueBands)
        path.move(to: CGPoint(x: 0, y: y))
        path.addLine(to: CGPoint(x: size.width, y: y))
      }
    }
  }

  private func activityLine(
    values: [Double],
    peak: Double,
    size: CGSize
  ) -> Path {
    Path { path in
      guard let firstValue = values.first else { return }
      var previousPoint = chartPoint(
        index: 0,
        value: firstValue,
        count: values.count,
        peak: peak,
        size: size
      )
      path.move(to: previousPoint)
      for index in values.indices.dropFirst() {
        let point = chartPoint(
          index: index,
          value: values[index],
          count: values.count,
          peak: peak,
          size: size
        )
        path.addLine(
          to: CGPoint(x: point.x, y: previousPoint.y)
        )
        path.addLine(to: point)
        previousPoint = point
      }
    }
  }

  private func activityArea(
    values: [Double],
    peak: Double,
    size: CGSize
  ) -> Path {
    Path { path in
      guard !values.isEmpty else { return }
      path.move(to: CGPoint(x: 0, y: size.height))
      var previousPoint = chartPoint(
        index: 0,
        value: values[0],
        count: values.count,
        peak: peak,
        size: size
      )
      path.addLine(to: previousPoint)
      for index in values.indices.dropFirst() {
        let point = chartPoint(
          index: index,
          value: values[index],
          count: values.count,
          peak: peak,
          size: size
        )
        path.addLine(
          to: CGPoint(x: point.x, y: previousPoint.y)
        )
        path.addLine(to: point)
        previousPoint = point
      }
      path.addLine(to: CGPoint(x: size.width, y: size.height))
      path.closeSubpath()
    }
  }

  private func chartPoint(
    index: Int,
    value: Double,
    count: Int,
    peak: Double,
    size: CGSize
  ) -> CGPoint {
    let x =
      count <= 1
      ? 0
      : size.width * CGFloat(index) / CGFloat(count - 1)
    let y = size.height * (1 - CGFloat(min(value / peak, 1)))
    return CGPoint(x: x, y: y)
  }

  private func updateCeiling(_ values: [Double]) {
    let next = stableScaleCeiling(
      peak: max(values.max() ?? 0, currentRate ?? 0),
      previous: ceiling
    )
    if next != ceiling {
      ceiling = next
    }
  }

  /// Places a mark at its own moment in the window, using the rate line's
  /// height there so the dot rides the curve instead of floating.
  private func markPoint(
    _ mark: ProviderEventMark,
    values: [Double],
    peak: Double,
    size: CGSize
  ) -> CGPoint {
    let x = size.width * CGFloat(min(max(mark.position, 0), 1))
    guard !values.isEmpty else {
      return CGPoint(x: x, y: size.height)
    }
    let index = Int(
      (Double(values.count - 1) * min(max(mark.position, 0), 1)).rounded()
    )
    let value = values[min(max(index, 0), values.count - 1)]
    let y = size.height * (1 - CGFloat(min(value / peak, 1)))
    return CGPoint(x: x, y: y)
  }

  private var accessibilityValue: String {
    let peak = displayedRates.max() ?? 0
    let visible =
      activity.series["all"]?
      .reduce(Int64(0)) { $0 + $1.tokens } ?? 0
    if let currentRate {
      return localizedFormat(
        "dashboard.chart.accessibilityValue.live",
        fallback:
          "Current %@ tokens per second. Peak %@ tokens per second. %lld tokens reported in the visible history. Completed reports, not in-flight generation speed.",
        formatRateValue(currentRate),
        formatRateValue(peak),
        visible
      )
    }
    return localizedFormat(
      "dashboard.chart.accessibilityValue.lastKnown",
      fallback:
        "Last known graph. Live rate unavailable. %lld tokens were reported in the retained history.",
      visible
    )
  }
}

private struct SparklineView: View {
  let points: [BucketPointDTO]
  let windowLabel: String
  let aggregateTotal: Int64

  var body: some View {
    GeometryReader { geometry in
      let peak = max(points.map(\.tokens).max() ?? 0, 1)
      let size = geometry.size

      ZStack {
        areaPath(peak: peak, size: size)
          .fill(
            LinearGradient(
              colors: [
                Color.accentColor.opacity(0.22),
                Color.accentColor.opacity(0.02),
              ],
              startPoint: .top,
              endPoint: .bottom
            )
          )

        linePath(peak: peak, size: size)
          .stroke(
            .tint,
            style: StrokeStyle(
              lineWidth: 1.8,
              lineCap: .round,
              lineJoin: .round
            )
          )

        if let last = sparklinePoint(
          index: points.count - 1,
          peak: peak,
          size: size
        ) {
          Circle()
            .fill(.tint)
            .frame(width: 4, height: 4)
            .position(last)
        }
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(
      localizedFormat(
        "dashboard.sparkline.accessibilityLabel",
        fallback: "Token activity over the last %@",
        windowLabel
      )
    )
    .accessibilityValue(accessibilityValue)
  }

  private func sparklinePoint(
    index: Int,
    peak: Int64,
    size: CGSize
  ) -> CGPoint? {
    guard points.indices.contains(index) else { return nil }
    let x =
      points.count <= 1
      ? size.width
      : size.width * CGFloat(index) / CGFloat(points.count - 1)
    let y =
      size.height
      * (1 - CGFloat(Double(points[index].tokens) / Double(peak)))
    return CGPoint(x: x, y: y)
  }

  private func linePath(peak: Int64, size: CGSize) -> Path {
    Path { path in
      for index in points.indices {
        guard
          let point = sparklinePoint(
            index: index,
            peak: peak,
            size: size
          )
        else {
          continue
        }
        if index == 0 {
          path.move(to: point)
        } else {
          path.addLine(to: point)
        }
      }
    }
  }

  private func areaPath(peak: Int64, size: CGSize) -> Path {
    Path { path in
      guard
        let first = sparklinePoint(
          index: 0,
          peak: peak,
          size: size
        )
      else {
        return
      }
      path.move(to: CGPoint(x: first.x, y: size.height))
      path.addLine(to: first)
      for index in points.indices.dropFirst() {
        if let point = sparklinePoint(
          index: index,
          peak: peak,
          size: size
        ) {
          path.addLine(to: point)
        }
      }
      path.addLine(to: CGPoint(x: size.width, y: size.height))
      path.closeSubpath()
    }
  }

  private var accessibilityValue: String {
    guard !points.isEmpty else {
      return localized(
        "dashboard.sparkline.noSamples",
        fallback: "No activity samples."
      )
    }

    let peak = points.map(\.tokens).max() ?? 0
    let first = points.first?.tokens ?? 0
    let last = points.last?.tokens ?? 0
    let trend: String
    if last > first {
      trend = localized(
        "dashboard.sparkline.trend.rising",
        fallback: "rising"
      )
    } else if last < first {
      trend = localized(
        "dashboard.sparkline.trend.falling",
        fallback: "falling"
      )
    } else {
      trend = localized(
        "dashboard.sparkline.trend.steady",
        fallback: "steady"
      )
    }

    return localizedFormat(
      "dashboard.sparkline.accessibilityValue",
      fallback:
        "%@ total %@ tokens. Peak bucket %@ tokens. Recent trend %@.",
      windowLabel,
      formatCompact(aggregateTotal),
      formatCompact(peak),
      trend
    )
  }
}

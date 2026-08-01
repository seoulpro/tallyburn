import Foundation

func makeSafeDiagnosticsReport(
  snapshot: UsageSnapshotDTO?,
  sidecarState: SidecarState
) -> String {
  let diagnostics = snapshot?.diagnostics
  let providers =
    diagnostics?.providers.mapValues { diagnostic in
      var activity: [String: Any] = [
        "state": diagnostic.activity.state,
        "reason": diagnostic.activity.reason,
        "filesSeen": diagnostic.activity.filesSeen,
        "filesRead": diagnostic.activity.filesRead,
        "malformedLines": diagnostic.activity.malformedLines,
      ]
      if let lastEventAt = diagnostic.activity.lastEventAt {
        activity["lastEventAt"] = lastEventAt
      }
      var quota: [String: Any] = [
        "state": diagnostic.quota.state,
        "hasPrimary": diagnostic.quota.hasPrimary,
        "hasSecondary": diagnostic.quota.hasSecondary,
      ]
      if let observedAt = diagnostic.quota.observedAt {
        quota["observedAt"] = observedAt
      }
      if let ageMs = diagnostic.quota.ageMs {
        quota["ageMs"] = ageMs
      }
      return [
        "provider": diagnostic.provider,
        "collection": diagnostic.collection,
        "activity": activity,
        "quota": quota,
      ] as [String: Any]
    } ?? [:]
  let report: [String: Any] = [
    "schemaVersion": 1,
    "type": "tallyburn-diagnostics",
    "generatedAt": diagnostics?.generatedAt
      ?? snapshot?.generatedAt
      ?? Date().timeIntervalSince1970 * 1_000,
    "engine": [
      "connection": safeSidecarState(sidecarState),
      "collection": diagnostics?.engine.state ?? "unknown",
    ],
    "providers": providers,
  ]
  guard
    let data = try? JSONSerialization.data(
      withJSONObject: report,
      options: [.prettyPrinted, .sortedKeys]
    )
  else {
    return "{}"
  }
  return String(decoding: data, as: UTF8.self)
}

private func safeSidecarState(_ state: SidecarState) -> String {
  switch state {
  case .idle: return "idle"
  case .starting: return "starting"
  case .connected: return "connected"
  case .paused: return "paused"
  case .failed: return "failed"
  }
}

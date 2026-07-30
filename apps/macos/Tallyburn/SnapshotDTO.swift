import Foundation

struct SnapshotEnvelope: Decodable {
  let schemaVersion: Int
  let type: String
  let sequence: Int
  let snapshot: UsageSnapshotDTO
}

struct UsageSnapshotDTO: Decodable {
  let generatedAt: Double
  let windows: [WindowAggregateDTO]
  let focusWindow: String
  let recentTokensPerMinute: Int64
  let recentRateWindowMs: Double?
  let liveRate: LiveRateDTO?
  let liveActivity: LiveActivityDTO?
  let series: [String: [BucketPointDTO]]
  let seriesByWindow: [String: [String: [BucketPointDTO]]]?
  let quotas: [String: QuotaSnapshotDTO]
  var accounts: [String: ProviderAccountStatusDTO]? = nil
  let sources: [String: SourceStatusDTO]
}

struct LiveRateDTO: Decodable {
  let trailingWindowMs: Double
  let all: ProviderRateDTO
  let providers: [String: ProviderRateDTO]
}

struct ProviderRateDTO: Decodable {
  let provider: String
  let observedTokens: Int64
  let tokensPerMinute: Int64
  let observations: Int
  let lastEventAt: Double?
}

struct LiveActivityDTO: Decodable {
  let historyWindowMs: Double
  let sampleIntervalMs: Double
  let rateWindowMs: Double
  let all: ProviderActivityDTO
  let providers: [String: ProviderActivityDTO]
  let series: [String: [BucketPointDTO]]
  let rateSeries: [String: [ActivityRatePointDTO]]?
}

struct ProviderActivityDTO: Decodable {
  let provider: String
  let observedTokens: Int64
  let tokensPerSecond: Double
  let observations: Int
  let lastEventAt: Double?
}

struct ActivityRatePointDTO: Decodable {
  let at: Double
  let tokensPerSecond: Double
}

struct WindowAggregateDTO: Decodable, Identifiable {
  var id: String { label }

  let label: String
  let durationMs: Double
  let all: ProviderAggregateDTO
  let providers: [String: ProviderAggregateDTO]
}

struct ProviderAggregateDTO: Decodable {
  let provider: String
  let observations: Int
  let freshInput: Int64
  let cacheRead: Int64
  let cacheWrite: Int64
  let output: Int64
  let reasoning: Int64
  let total: Int64
  let lastEventAt: Double?
}

struct BucketPointDTO: Decodable {
  let start: Double
  let tokens: Int64
}

struct QuotaSnapshotDTO: Decodable {
  let provider: String
  let timestamp: Double
  let planType: String?
  let primary: QuotaWindowDTO?
  let secondary: QuotaWindowDTO?
}

struct QuotaWindowDTO: Decodable {
  let usedPercent: Double
  let windowMs: Double
  let resetsAt: Double?
}

struct ProviderAccountStatusDTO: Decodable {
  let provider: String
  let observedAt: Double
  let loggedIn: Bool
  let subscriptionType: String?
}

struct SourceStatusDTO: Decodable {
  let provider: String
  let available: Bool
  let filesSeen: Int
  let filesRead: Int
  let malformedLines: Int
  let lastEventAt: Double?
}

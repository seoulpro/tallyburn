import AppKit
import SwiftUI

/// Provider colours are categorical identity cues, never status signals.
/// Names remain visible beside every swatch so colour is not the only way to
/// distinguish providers.
private let providerPalette: [NSColor] = [
  .systemBlue,
  .systemOrange,
  .systemPurple,
  .systemGreen,
  .systemTeal,
  .systemPink,
  .systemIndigo,
  .systemBrown,
]

private let providerPaletteIndex: [String: Int] = [
  "codex": 0,
  "claude": 1,
  "gemini": 3,
  "copilot": 5,
  "qwen": 2,
  "ollama": 3,
  "lmstudio": 4,
  "llamacpp": 4,
  "vllm": 6,
]

private struct ProviderColorOverridesKey: EnvironmentKey {
  static let defaultValue: [String: String] = [:]
}

extension EnvironmentValues {
  var providerColorOverrides: [String: String] {
    get { self[ProviderColorOverridesKey.self] }
    set { self[ProviderColorOverridesKey.self] = newValue }
  }
}

func canonicalProviderKey(_ name: String) -> String {
  name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
}

func providerDisplayName(_ name: String) -> String {
  switch canonicalProviderKey(name) {
  case "codex": return "Codex"
  case "claude": return "Claude"
  case "gemini": return "Gemini"
  case "copilot": return "GitHub Copilot"
  case "qwen": return "Qwen"
  case "ollama": return "Ollama"
  case "lmstudio": return "LM Studio"
  case "llamacpp": return "llama.cpp"
  case "vllm": return "vLLM"
  default:
    return name.trimmingCharacters(in: .whitespacesAndNewlines)
      .capitalized
  }
}

/// Returns a stable system colour for providers that do not yet have a user
/// override. Swift's randomized `hashValue` is intentionally avoided so a
/// newly observed provider keeps the same colour across launches.
func defaultProviderTint(_ name: String) -> Color {
  Color(nsColor: defaultProviderNSColor(name))
}

func defaultProviderColorHex(_ name: String) -> String {
  sRGBHex(defaultProviderNSColor(name)) ?? "#0A84FF"
}

func providerTint(
  _ name: String,
  overrides: [String: String] = [:]
) -> Color {
  let key = canonicalProviderKey(name)
  if let hex = overrides[key],
    let color = colorFromHex(hex)
  {
    return Color(nsColor: color)
  }
  return defaultProviderTint(name)
}

func normalizedProviderColorHex(_ value: String) -> String? {
  let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
  let digits = trimmed.hasPrefix("#") ? String(trimmed.dropFirst()) : trimmed
  guard digits.count == 6,
    digits.unicodeScalars.allSatisfy({
      CharacterSet(charactersIn: "0123456789abcdefABCDEF")
        .contains($0)
    })
  else {
    return nil
  }
  return "#\(digits.uppercased())"
}

func normalizedProviderColorOverrides(
  _ values: [String: String]
) -> [String: String] {
  var normalized: [String: String] = [:]
  for (name, value) in values {
    let key = canonicalProviderKey(name)
    guard isValidProviderKey(key),
      let hex = normalizedProviderColorHex(value)
    else {
      continue
    }
    normalized[key] = hex
  }
  return normalized
}

func loadProviderColorOverrides(_ value: Any?) -> [String: String] {
  guard let dictionary = value as? [String: Any] else { return [:] }
  let strings = dictionary.compactMapValues { $0 as? String }
  return normalizedProviderColorOverrides(strings)
}

func providerColorHex(_ color: Color) -> String? {
  sRGBHex(NSColor(color))
}

private func defaultProviderNSColor(_ name: String) -> NSColor {
  let key = canonicalProviderKey(name)
  let index =
    providerPaletteIndex[key]
    ?? Int(stableProviderHash(key) % UInt64(providerPalette.count))
  return providerPalette[index]
}

private func stableProviderHash(_ value: String) -> UInt64 {
  var hash: UInt64 = 1_469_598_103_934_665_603
  for byte in value.utf8 {
    hash ^= UInt64(byte)
    hash &*= 1_099_511_628_211
  }
  return hash
}

private func isValidProviderKey(_ value: String) -> Bool {
  guard !value.isEmpty, value.utf8.count <= 64 else { return false }
  let allowed = CharacterSet(
    charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789._-"
  )
  return value.unicodeScalars.allSatisfy(allowed.contains)
}

private func colorFromHex(_ value: String) -> NSColor? {
  guard let normalized = normalizedProviderColorHex(value) else {
    return nil
  }
  let digits = normalized.dropFirst()
  guard let rgb = UInt32(digits, radix: 16) else { return nil }
  return NSColor(
    srgbRed: CGFloat((rgb >> 16) & 0xFF) / 255,
    green: CGFloat((rgb >> 8) & 0xFF) / 255,
    blue: CGFloat(rgb & 0xFF) / 255,
    alpha: 1
  )
}

private func sRGBHex(_ color: NSColor) -> String? {
  guard
    let resolved =
      color.usingColorSpace(.sRGB)
      ?? color.usingColorSpace(.deviceRGB)
  else {
    return nil
  }
  var red: CGFloat = 0
  var green: CGFloat = 0
  var blue: CGFloat = 0
  var alpha: CGFloat = 0
  resolved.getRed(
    &red,
    green: &green,
    blue: &blue,
    alpha: &alpha
  )
  let channel: (CGFloat) -> Int = {
    Int((min(max($0, 0), 1) * 255).rounded())
  }
  return String(
    format: "#%02X%02X%02X",
    channel(red),
    channel(green),
    channel(blue)
  )
}

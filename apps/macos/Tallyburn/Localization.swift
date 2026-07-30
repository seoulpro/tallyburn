import Foundation

func localized(_ key: String, fallback: String) -> String {
  Bundle.main.localizedString(
    forKey: key,
    value: fallback,
    table: nil
  )
}

func localizedFormat(
  _ key: String,
  fallback: String,
  _ arguments: CVarArg...
) -> String {
  String(
    format: localized(key, fallback: fallback),
    locale: Locale.current,
    arguments: arguments
  )
}

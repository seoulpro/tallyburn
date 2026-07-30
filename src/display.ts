import { homedir } from "node:os";

export function sanitizeTerminalText(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0xff
      ? `\\x${codePoint.toString(16).padStart(2, "0")}`
      : `\\u{${codePoint.toString(16)}}`;
  });
}

export function displayPath(
  value: string,
  home = homedir(),
): string {
  const normalizedValue = value.replaceAll("\\", "/");
  const normalizedHome = home.replaceAll("\\", "/").replace(/\/+$/, "");
  const windowsPath = /^[A-Za-z]:\//.test(normalizedValue);
  const comparableValue = windowsPath
    ? normalizedValue.toLowerCase()
    : normalizedValue;
  const comparableHome = windowsPath
    ? normalizedHome.toLowerCase()
    : normalizedHome;

  let displayed = value;
  if (comparableValue === comparableHome) {
    displayed = "~";
  } else if (comparableValue.startsWith(`${comparableHome}/`)) {
    displayed = `~/${normalizedValue.slice(normalizedHome.length + 1)}`;
  }
  return sanitizeTerminalText(displayed);
}

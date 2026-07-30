const UNITS: Readonly<Record<string, number>> = Object.freeze({
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
});

export interface NamedDuration {
  label: string;
  durationMs: number;
}

export function parseDuration(input: string): number {
  const value = input.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value);
  if (!match) {
    throw new Error(
      `Invalid duration "${input}". Use a number followed by ms, s, m, h, or d.`,
    );
  }

  const amount = Number(match[1]);
  const unit = UNITS[match[2] ?? ""];
  const duration = amount * (unit ?? 0);
  const rounded = Math.round(duration);
  if (!Number.isFinite(duration) || rounded <= 0) {
    throw new Error(`Duration must be greater than zero: "${input}".`);
  }
  return rounded;
}

export function parseWindows(input: string): NamedDuration[] {
  const labels = input
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

  if (labels.length === 0) {
    throw new Error("At least one usage window is required.");
  }

  const unique = new Map<number, string>();
  for (const label of labels) {
    const durationMs = parseDuration(label);
    if (durationMs > 30 * 86_400_000) {
      throw new Error(`Usage windows cannot exceed 30 days: "${label}".`);
    }
    unique.set(durationMs, label);
  }

  return [...unique.entries()]
    .sort(([left], [right]) => left - right)
    .map(([durationMs, label]) => ({ label, durationMs }));
}

export function formatDuration(durationMs: number): string {
  const candidates: Array<[string, number]> = [
    ["d", 86_400_000],
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1_000],
    ["ms", 1],
  ];

  for (const [suffix, unit] of candidates) {
    if (durationMs >= unit && durationMs % unit === 0) {
      return `${durationMs / unit}${suffix}`;
    }
  }
  return `${durationMs}ms`;
}

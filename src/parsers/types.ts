import type {
  Provider,
  QuotaSnapshot,
  QuotaWindow,
  UsageEvent,
} from "../model.js";

export interface ParserState {
  sourceKey: string;
  sessionId?: string;
  model?: string;
  codexCumulative?: CodexCounters;
  codexParentSessionId?: string;
  codexSessionStartedAt?: number;
}

export interface CodexCounters {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
}

export interface ParsedLine {
  event?: UsageEvent;
  quota?: QuotaSnapshot;
  quotaWindowUpdate?: {
    provider: Provider;
    key: "primary" | "secondary";
    timestamp: number;
    window: QuotaWindow;
  };
  sessionId?: string;
  model?: string;
  codexCumulative?: CodexCounters;
  codexParentSessionId?: string;
  codexSessionStartedAt?: number;
}

export type LineParser = (
  value: unknown,
  state: Readonly<ParserState>,
) => ParsedLine;

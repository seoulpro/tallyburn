import { createHash } from "node:crypto";

/**
 * Produces a deterministic, non-reversible local event key without retaining
 * provider session, request, or message identifiers in the normalized model.
 */
export function opaqueEventId(
  namespace: string,
  ...parts: readonly string[]
): string {
  const digest = createHash("sha256");
  for (const part of parts) {
    digest.update(String(Buffer.byteLength(part)));
    digest.update(":");
    digest.update(part);
    digest.update(";");
  }
  return `${namespace}:${digest.digest("base64url").slice(0, 22)}`;
}

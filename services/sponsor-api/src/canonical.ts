import { createHmac, timingSafeEqual } from "node:crypto";
import type { Quote, QuoteSigner } from "./types.js";

/** Stable JSON for the exact bytes signed by an off-chain signer and verified on-chain. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

export function canonicalQuote(quote: Quote): string {
  return canonicalize(quote);
}

/** Development-only adapter. Production must use the key type checked by the Anchor program. */
export class HmacSha256QuoteSigner implements QuoteSigner {
  constructor(
    private readonly secret: string,
    public readonly publicKey: string = "comfi-dev-hmac-authority",
  ) {}

  async sign(canonicalPayload: string): Promise<string> {
    return createHmac("sha256", this.secret).update(canonicalPayload).digest("base64url");
  }

  async verify(canonicalPayload: string, signature: string): Promise<boolean> {
    const expected = await this.sign(canonicalPayload);
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

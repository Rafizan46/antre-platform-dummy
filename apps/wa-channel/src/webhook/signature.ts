// X-Hub-Signature-256 of the Meta webhook (FR-WA-02, NFR-SECU-02): HMAC-SHA256 of the exact raw
// request body with the App Secret, sent as `sha256=<hex>`. Compared in constant time.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-hub-signature-256';

// Meta sends lowercase hex; anything else is rejected (strict format).
const HEADER_PATTERN = /^sha256=([0-9a-f]{64})$/;

/** Header value for `rawBody` (used by tests and the local webhook simulator). */
export function signPayload(rawBody: Buffer | string, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

/** A missing, repeated, or malformed header is simply false. */
export function verifySignature(
  rawBody: Buffer,
  header: string | string[] | undefined,
  appSecret: string,
): boolean {
  if (typeof header !== 'string') return false;
  const match = HEADER_PATTERN.exec(header);
  if (match === null) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(match[1]!, 'hex'));
}

/** Constant-time comparison of two strings of any length (verify token). */
export function secretMatches(presented: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

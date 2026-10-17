// HMAC-SHA256 signature of the QRIS payment callback (spec section 7.4). The signature covers the
// exact bytes of the request body, sent in the `X-Antre-Signature` header as `sha256=<hex>`.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-antre-signature';

const HEADER_PATTERN = /^sha256=([0-9a-fA-F]{64})$/;

/** The header value for `rawBody`: `sha256=` and 64 lowercase hex digits. */
export function signatureHeader(rawBody: Buffer | string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/** Constant-time check; a missing, repeated, or malformed header is simply false. */
export function verifySignature(
  rawBody: Buffer,
  header: string | string[] | undefined,
  secret: string,
): boolean {
  if (typeof header !== 'string') return false;
  const match = HEADER_PATTERN.exec(header);
  if (match === null) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(match[1]!, 'hex'));
}

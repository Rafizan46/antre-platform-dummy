// KIOSK_DISPLAY tokens (FR-AUTH-02, FR-REALTIME-02, S10): JWT HS256 with the issuer, audience,
// and secret of the user tokens, issued by the owner per location and valid for 30 days. The only
// consumer is the Realtime SSE Gateway (stream of that location); the user-token verifier of the
// core services rejects them, because KIOSK_DISPLAY is not a user role.
//
// Claims: sub = random token id (UUID), role = KIOSK_DISPLAY, tenant_id, location_id, iat, exp,
// and iat_ms (issue instant in milliseconds). Revocation is per location: the gateway rejects a
// token whose iat_ms is not after the revocation instant stored in Redis (see redis-realtime.ts).
import { randomUUID } from 'node:crypto';

import { KIOSK_TOKEN_TTL_SECONDS } from '@antre/messaging/realtime';
import { SignJWT } from 'jose';

import { TOKEN_AUDIENCE, TOKEN_ISSUER } from './tokens.js';

export interface KioskToken {
  token: string;
  tokenId: string;
  expiresIn: number;
  expiresAt: Date;
}

export async function signKioskToken(options: {
  secret: string;
  tenantId: string;
  locationId: string;
  now: Date;
}): Promise<KioskToken> {
  const key = new TextEncoder().encode(options.secret);
  const issuedAtMs = options.now.getTime();
  const issuedAt = Math.floor(issuedAtMs / 1000);
  const tokenId = randomUUID();
  const token = await new SignJWT({
    role: 'KIOSK_DISPLAY',
    tenant_id: options.tenantId,
    location_id: options.locationId,
    iat_ms: issuedAtMs,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(tokenId)
    .setIssuer(TOKEN_ISSUER)
    .setAudience(TOKEN_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + KIOSK_TOKEN_TTL_SECONDS)
    .sign(key);
  return {
    token,
    tokenId,
    expiresIn: KIOSK_TOKEN_TTL_SECONDS,
    expiresAt: new Date((issuedAt + KIOSK_TOKEN_TTL_SECONDS) * 1000),
  };
}

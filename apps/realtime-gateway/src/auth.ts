// Stream authentication (FR-AUTH-02, FR-REALTIME-01/02): JWT HS256 from the core services, with
// the issuer, audience, and secret of the user tokens. OWNER and STAFF_* tokens may open the stream
// of any location id; the gateway subscribes only to rt:{token tenant}:{location}, so a location of
// another tenant yields an empty stream (tenant isolation by channel). KIOSK_DISPLAY tokens open only
// the stream of their own location. SUPER_ADMIN and service tokens are refused (403).
//
// Unlike the core services, the gateway has no database: a deactivated user can open streams until
// the user token expires (8 h); an open stream ends after REALTIME_MAX_STREAM_SECONDS at most.
import { TENANT_ROLES, TOKEN_ROLES, uuidSchema, type TenantRole } from '@antre/shared-types';
import { jwtVerify } from 'jose';
import { z } from 'zod';

export const TOKEN_ISSUER = 'antre-auth';
export const TOKEN_AUDIENCE = 'antre-api';

export type Principal =
  | { kind: 'staff'; userId: string; tenantId: string; role: TenantRole; expiresAt: number }
  | {
      kind: 'kiosk';
      tokenId: string;
      tenantId: string;
      locationId: string;
      issuedAtMs: number;
      expiresAt: number;
    }
  | { kind: 'other' };

const baseSchema = z.object({
  sub: uuidSchema,
  role: z.enum(TOKEN_ROLES),
  exp: z.number().int(),
});
const lowerUuid = uuidSchema.transform((value) => value.toLowerCase());
const staffSchema = z.object({ tenant_id: lowerUuid });
const kioskSchema = z.object({
  tenant_id: lowerUuid,
  location_id: lowerUuid,
  iat_ms: z.number().int().nonnegative(),
});

export interface TokenVerifier {
  /** null for an invalid, expired, or malformed token; the reason is not exposed. */
  verify(token: string): Promise<Principal | null>;
}

export function createTokenVerifier(options: { secret: string; now: () => Date }): TokenVerifier {
  const key = new TextEncoder().encode(options.secret);
  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, key, {
          algorithms: ['HS256'],
          issuer: TOKEN_ISSUER,
          audience: TOKEN_AUDIENCE,
          currentDate: options.now(),
          requiredClaims: ['sub', 'iat', 'exp'],
        });
        const base = baseSchema.parse(payload);
        const expiresAt = base.exp * 1000;
        if (base.role === 'KIOSK_DISPLAY') {
          const kiosk = kioskSchema.parse(payload);
          return {
            kind: 'kiosk',
            tokenId: base.sub,
            tenantId: kiosk.tenant_id,
            locationId: kiosk.location_id,
            issuedAtMs: kiosk.iat_ms,
            expiresAt,
          };
        }
        if ((TENANT_ROLES as readonly string[]).includes(base.role)) {
          const staff = staffSchema.parse(payload);
          return {
            kind: 'staff',
            userId: base.sub,
            tenantId: staff.tenant_id,
            role: base.role as TenantRole,
            expiresAt,
          };
        }
        return { kind: 'other' };
      } catch {
        return null;
      }
    },
  };
}

/** Reads the token from `?access_token=` (EventSource cannot send headers) or a bearer header. */
export function extractToken(query: unknown, authorization: string | undefined): string | null {
  const fromQuery = (query as { access_token?: unknown } | null)?.access_token;
  if (typeof fromQuery === 'string' && fromQuery !== '') return fromQuery;
  const match = authorization === undefined ? null : /^Bearer ([^\s]+)$/.exec(authorization);
  return match?.[1] ?? null;
}

// Access tokens: JWT HS256 signed and verified with jose (FR-AUTH-02).
import { USER_ROLES, uuidSchema, type UserRole } from '@antre/shared-types';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';

export const TOKEN_ISSUER = 'antre-auth';
export const TOKEN_AUDIENCE = 'antre-api';
export const DEFAULT_TOKEN_TTL_SECONDS = 28_800; // 8 hours, no refresh token

export interface AuthContext {
  userId: string;
  tenantId: string | null;
  role: UserRole;
}

export interface TokenService {
  sign(subject: AuthContext): Promise<{ token: string; expiresIn: number }>;
  /** Returns null for every kind of failure; the reason is deliberately not exposed. */
  verify(token: string): Promise<AuthContext | null>;
}

const payloadSchema = z.object({
  sub: uuidSchema,
  role: z.enum(USER_ROLES),
  tenant_id: uuidSchema.nullable(),
});

export function createTokenService(options: {
  secret: string;
  now: () => Date;
  ttlSeconds?: number;
}): TokenService {
  const key = new TextEncoder().encode(options.secret);
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;

  return {
    async sign({ userId, tenantId, role }) {
      const issuedAt = Math.floor(options.now().getTime() / 1000);
      const token = await new SignJWT({ tenant_id: tenantId, role })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(userId)
        .setIssuer(TOKEN_ISSUER)
        .setAudience(TOKEN_AUDIENCE)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + ttlSeconds)
        .sign(key);
      return { token, expiresIn: ttlSeconds };
    },

    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, key, {
          algorithms: ['HS256'],
          issuer: TOKEN_ISSUER,
          audience: TOKEN_AUDIENCE,
          currentDate: options.now(),
          requiredClaims: ['sub', 'iat', 'exp'],
        });
        const claims = payloadSchema.parse(payload);
        // SUPER_ADMIN is the only role without a tenant, and the only one allowed to lack it.
        if ((claims.role === 'SUPER_ADMIN') !== (claims.tenant_id === null)) return null;
        return { userId: claims.sub, tenantId: claims.tenant_id, role: claims.role };
      } catch {
        return null;
      }
    },
  };
}

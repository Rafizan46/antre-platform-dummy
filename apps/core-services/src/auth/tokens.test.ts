import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import { createTokenService, type AuthContext } from './tokens.js';

const SECRET = 'a-valid-secret-of-at-least-32-characters-long';
const NOW = new Date('2026-10-17T10:00:00Z');
const TTL = 28_800;
const owner: AuthContext = {
  userId: '9e2c4b1a-6f3d-4c8e-b2a7-1d5f9e0c3b42',
  tenantId: 'c38a2e12-88f5-4f32-843e-90cb6d88f9a1',
  role: 'OWNER',
};

function service(secret = SECRET, now = NOW) {
  return createTokenService({ secret, now: () => now });
}

const key = (secret: string) => new TextEncoder().encode(secret);
const epoch = (date: Date) => Math.floor(date.getTime() / 1000);

async function craft(
  claims: Record<string, unknown>,
  options: { alg?: string; secret?: string; iss?: string; aud?: string; sub?: string } = {},
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: options.alg ?? 'HS256', typ: 'JWT' })
    .setSubject(options.sub ?? owner.userId)
    .setIssuer(options.iss ?? 'antre-auth')
    .setAudience(options.aud ?? 'antre-api')
    .setIssuedAt(epoch(NOW))
    .setExpirationTime(epoch(NOW) + TTL)
    .sign(key(options.secret ?? SECRET));
}

describe('token service', () => {
  it('round-trips a token', async () => {
    const tokens = service();
    const { token, expiresIn } = await tokens.sign(owner);
    expect(expiresIn).toBe(TTL);
    expect(await tokens.verify(token)).toEqual(owner);
  });

  it('round-trips a SUPER_ADMIN without tenant', async () => {
    const tokens = service();
    const admin: AuthContext = { userId: owner.userId, tenantId: null, role: 'SUPER_ADMIN' };
    const { token } = await tokens.sign(admin);
    expect(await tokens.verify(token)).toEqual(admin);
  });

  it('rejects an expired token', async () => {
    const { token } = await service().sign(owner);
    const later = new Date(NOW.getTime() + (TTL + 1) * 1000);
    expect(await service(SECRET, later).verify(token)).toBeNull();
    const justBefore = new Date(NOW.getTime() + (TTL - 1) * 1000);
    expect(await service(SECRET, justBefore).verify(token)).toEqual(owner);
  });

  it('rejects another secret', async () => {
    const { token } = await service().sign(owner);
    expect(await service('another-secret-of-at-least-32-characters-xx').verify(token)).toBeNull();
  });

  it('rejects garbage', async () => {
    expect(await service().verify('abc')).toBeNull();
    expect(await service().verify('')).toBeNull();
  });

  it('rejects a hand-made alg none token', async () => {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
      sub: owner.userId,
      tenant_id: owner.tenantId,
      role: 'OWNER',
      iss: 'antre-auth',
      aud: 'antre-api',
      iat: epoch(NOW),
      exp: epoch(NOW) + TTL,
    })}.`;
    expect(await service().verify(token)).toBeNull();
  });

  it('rejects HS512 even with the right secret', async () => {
    const token = await craft({ tenant_id: owner.tenantId, role: 'OWNER' }, { alg: 'HS512' });
    expect(await service().verify(token)).toBeNull();
  });

  it('rejects wrong issuer or audience', async () => {
    const claims = { tenant_id: owner.tenantId, role: 'OWNER' };
    expect(await service().verify(await craft(claims, { iss: 'evil' }))).toBeNull();
    expect(await service().verify(await craft(claims, { aud: 'evil' }))).toBeNull();
    expect(await service().verify(await craft(claims))).toEqual(owner);
  });

  it('rejects an invalid role, subject, or tenant combination', async () => {
    const tenantId = owner.tenantId;
    expect(await service().verify(await craft({ tenant_id: tenantId, role: 'ROOT' }))).toBeNull();
    expect(
      await service().verify(await craft({ tenant_id: tenantId, role: 'KIOSK_DISPLAY' })),
    ).toBeNull();
    expect(
      await service().verify(await craft({ tenant_id: tenantId, role: 'OWNER' }, { sub: 'x' })),
    ).toBeNull();
    expect(
      await service().verify(await craft({ tenant_id: tenantId, role: 'SUPER_ADMIN' })),
    ).toBeNull();
    expect(await service().verify(await craft({ tenant_id: null, role: 'OWNER' }))).toBeNull();
    expect(await service().verify(await craft({ role: 'OWNER' }))).toBeNull();
  });
});

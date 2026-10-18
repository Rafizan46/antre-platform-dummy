import { describe, expect, it } from 'vitest';

import { createDummyVerifier, hashPassword, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('produces the documented format', async () => {
    const hash = await hashPassword('correct horse');
    expect(hash).toMatch(/^scrypt\$32768\$8\$3\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse');
    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('wrong horse', hash)).toBe(false);
  });

  it('uses a different salt each time', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
  });

  it('normalises with NFKC', async () => {
    const hash = await hashPassword('ﬁle-password');
    expect(await verifyPassword('file-password', hash)).toBe(true);
  });

  it('returns false for malformed stored values without throwing', async () => {
    const salt = 'A'.repeat(22);
    const hash = 'A'.repeat(43);
    for (const stored of [
      '',
      'plain',
      'scrypt$1$2$3',
      `bcrypt$32768$8$3$${salt}$${hash}`,
      `scrypt$32768$8$3$${salt}`,
      `scrypt$abc$8$3$${salt}$${hash}`,
      `scrypt$32769$8$3$${salt}$${hash}`,
      `scrypt$8192$8$3$${salt}$${hash}`,
      `scrypt$32768$0$3$${salt}$${hash}`,
      `scrypt$32768$8$0$${salt}$${hash}`,
      `scrypt$32768$8$99$${salt}$${hash}`,
      `scrypt$32768$8$3$AA$${hash}`,
      `scrypt$32768$8$3$${salt}$AA`,
    ]) {
      expect(await verifyPassword('x', stored)).toBe(false);
    }
  });

  it('refuses extreme parameters without allocating memory', async () => {
    const salt = 'A'.repeat(22);
    const hash = 'A'.repeat(43);
    expect(await verifyPassword('x', `scrypt$1048576$32$16$${salt}$${hash}`)).toBe(false);
    expect(await verifyPassword('x', `scrypt$1048576$8$1$${salt}$${hash}`)).toBe(false);
    expect(await verifyPassword('x', `scrypt$65536$8$1$${salt}$${hash}`)).toBe(false);
  });

  it('dummy verifier never matches', async () => {
    const verify = createDummyVerifier();
    expect(await verify('anything')).toBe(false);
  });
});

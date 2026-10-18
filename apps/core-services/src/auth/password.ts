// Password hashing with scrypt (node:crypto). Stored format:
// scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const PARAMS = { N: 32_768, r: 8, p: 3 } as const; // 2^15, equivalent in cost to OWASP 2^17/r8/p1
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const MAX_MEMORY = 64 * 1024 * 1024;

function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, keyLength, options, (error, key) => {
      if (error) {
        reject(error);
      } else {
        resolve(key);
      }
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await deriveKey(password, salt, KEY_LENGTH, { ...PARAMS, maxmem: MAX_MEMORY });
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

function parsePositiveInt(value: string): number {
  return /^[0-9]{1,9}$/.test(value) ? Number(value) : Number.NaN;
}

/** Never throws: a malformed or out-of-policy stored value simply does not match. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

    const N = parsePositiveInt(parts[1] ?? '');
    const r = parsePositiveInt(parts[2] ?? '');
    const p = parsePositiveInt(parts[3] ?? '');
    const isPowerOfTwo = Number.isInteger(N) && N > 0 && (N & (N - 1)) === 0;
    if (!isPowerOfTwo || N < 2 ** 14 || N > 2 ** 20) return false;
    if (!(r >= 1 && r <= 32) || !(p >= 1 && p <= 16)) return false;
    // scrypt needs about 128 * N * r bytes; refuse parameters beyond the memory budget.
    if (128 * N * r > MAX_MEMORY) return false;

    const salt = Buffer.from(parts[4] ?? '', 'base64url');
    const expected = Buffer.from(parts[5] ?? '', 'base64url');
    if (salt.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) return false;

    const actual = await deriveKey(password, salt, KEY_LENGTH, { N, r, p, maxmem: MAX_MEMORY });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Returns a function that verifies against a dummy hash, so login for an unknown email costs the
 * same as for a known one. The dummy hash starts computing immediately (not lazily).
 */
export function createDummyVerifier(): (password: string) => Promise<boolean> {
  const dummyHash = hashPassword(randomBytes(16).toString('hex'));
  return async (password) => verifyPassword(password, await dummyHash);
}

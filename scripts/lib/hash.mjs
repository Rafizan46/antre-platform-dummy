// Hash password dengan format yang sama dengan apps/core-services/src/auth/password.ts:
// scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>. Kesesuaiannya diuji di core-services.
import { randomBytes, scrypt } from 'node:crypto';

const PARAMS = { N: 32_768, r: 8, p: 3 };

export function hashPassword(password) {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      32,
      { ...PARAMS, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(
          [
            'scrypt',
            PARAMS.N,
            PARAMS.r,
            PARAMS.p,
            salt.toString('base64url'),
            key.toString('base64url'),
          ].join('$'),
        );
      },
    );
  });
}

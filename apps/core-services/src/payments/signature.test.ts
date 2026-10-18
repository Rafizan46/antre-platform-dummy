import { describe, expect, it } from 'vitest';

import { signatureHeader, verifySignature } from './signature.js';

const SECRET = 'a-valid-payment-secret-of-at-least-32-chars';
const BODY = Buffer.from('{"payment_ref":"pay-1","amount":50000}');

describe('signatureHeader', () => {
  it('is sha256= followed by 64 lowercase hex digits', () => {
    expect(signatureHeader(BODY, SECRET)).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signatureHeader(BODY.toString(), SECRET)).toBe(signatureHeader(BODY, SECRET));
  });
});

describe('verifySignature', () => {
  it('accepts the signature of the same body and secret', () => {
    expect(verifySignature(BODY, signatureHeader(BODY, SECRET), SECRET)).toBe(true);
    expect(
      verifySignature(
        BODY,
        signatureHeader(BODY, SECRET).toUpperCase().replace('SHA256=', 'sha256='),
        SECRET,
      ),
    ).toBe(true);
  });

  it('rejects another secret and a body changed by one byte', () => {
    const header = signatureHeader(BODY, SECRET);
    expect(verifySignature(BODY, header, `${SECRET}x`)).toBe(false);
    const changed = Buffer.from(BODY);
    changed[10] = changed[10]! ^ 1;
    expect(verifySignature(changed, header, SECRET)).toBe(false);
  });

  it('rejects a missing, repeated, or malformed header', () => {
    const header = signatureHeader(BODY, SECRET);
    expect(verifySignature(BODY, undefined, SECRET)).toBe(false);
    expect(verifySignature(BODY, [header], SECRET)).toBe(false);
    expect(verifySignature(BODY, header.slice('sha256='.length), SECRET)).toBe(false);
    expect(verifySignature(BODY, header.slice(0, -2), SECRET)).toBe(false);
    expect(verifySignature(BODY, `sha1=${header.slice(7)}`, SECRET)).toBe(false);
    expect(verifySignature(BODY, `${header}0`, SECRET)).toBe(false);
    expect(verifySignature(BODY, '', SECRET)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import {
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  STAFF_ROLES,
  TENANT_ROLES,
  TOKEN_ROLES,
  USER_ROLES,
} from './index.js';

describe('@antre/shared-types', () => {
  it('gives every error code an HTTP status', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
    expect(Object.keys(ERROR_HTTP_STATUS).sort()).toEqual([...ERROR_CODES].sort());
  });

  it('maps the documented codes to their status', () => {
    expect(ERROR_HTTP_STATUS.VALIDATION_ERROR).toBe(400);
    expect(ERROR_HTTP_STATUS.UNAUTHORIZED).toBe(401);
    expect(ERROR_HTTP_STATUS.FORBIDDEN).toBe(403);
    expect(ERROR_HTTP_STATUS.ALREADY_EXISTS).toBe(409);
    expect(ERROR_HTTP_STATUS.RATE_LIMITED).toBe(429);
    expect(ERROR_HTTP_STATUS.INTERNAL_ERROR).toBe(500);
  });

  it('keeps the role sets consistent with the database CHECK', () => {
    expect([...USER_ROLES]).toEqual(['OWNER', 'STAFF_CALLER', 'STAFF_CASHIER', 'SUPER_ADMIN']);
    expect([...STAFF_ROLES]).toEqual(['STAFF_CALLER', 'STAFF_CASHIER']);
    expect([...TENANT_ROLES]).toEqual(['OWNER', 'STAFF_CALLER', 'STAFF_CASHIER']);
    expect(TOKEN_ROLES).toEqual(expect.arrayContaining([...USER_ROLES]));
    expect(TOKEN_ROLES).toContain('KIOSK_DISPLAY');
    expect(TOKEN_ROLES).toContain('SYSTEM_WA_CHANNEL');
  });
});

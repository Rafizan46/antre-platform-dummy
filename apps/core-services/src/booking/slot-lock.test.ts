import { describe, expect, it } from 'vitest';

import { HOLD_TTL_MS, InMemorySlotLock, RELEASE_SCRIPT, slotLockKey } from './slot-lock.js';

describe('slotLockKey', () => {
  it('uses the resource id and the UTC start with milliseconds', () => {
    const key = slotLockKey('res-1', new Date('2026-10-19T10:00:00+07:00'));
    expect(key).toBe('lock:slot:res-1:2026-10-19T03:00:00.000Z');
  });
});

describe('RELEASE_SCRIPT', () => {
  it('compares before deleting', () => {
    expect(RELEASE_SCRIPT).toContain('GET');
    expect(RELEASE_SCRIPT).toContain('DEL');
    expect(HOLD_TTL_MS).toBe(300_000);
  });
});

describe('InMemorySlotLock', () => {
  it('takes a key only once (NX)', async () => {
    const lock = new InMemorySlotLock();
    expect(await lock.acquire('k', 'a', HOLD_TTL_MS)).toBe(true);
    expect(await lock.acquire('k', 'b', HOLD_TTL_MS)).toBe(false);
  });

  it('frees the key after the TTL', async () => {
    let now = 1000;
    const lock = new InMemorySlotLock({ now: () => now });
    await lock.acquire('k', 'a', 100);
    now = 1099;
    expect(await lock.acquire('k', 'b', 100)).toBe(false);
    now = 1100;
    expect(await lock.held(['k'])).toEqual(new Set());
    expect(await lock.acquire('k', 'b', 100)).toBe(true);
  });

  it('releases only with the matching token', async () => {
    const lock = new InMemorySlotLock();
    await lock.acquire('k', 'a', HOLD_TTL_MS);
    expect(await lock.release('k', 'wrong')).toBe(false);
    expect(await lock.held(['k'])).toEqual(new Set(['k']));
    expect(await lock.release('k', 'a')).toBe(true);
    expect(await lock.release('k', 'a')).toBe(false);
    expect(await lock.held(['k'])).toEqual(new Set());
  });

  it('reports which of the keys exist', async () => {
    const lock = new InMemorySlotLock();
    await lock.acquire('k1', 'a', HOLD_TTL_MS);
    await lock.acquire('k3', 'a', HOLD_TTL_MS);
    expect(await lock.held(['k1', 'k2', 'k3'])).toEqual(new Set(['k1', 'k3']));
    expect(await lock.held([])).toEqual(new Set());
  });
});

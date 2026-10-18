import { createEvent } from '@antre/event-contracts';
import { jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';

import { FanoutEventPublisher, InMemoryEventPublisher } from '../events/publisher.js';
import { signKioskToken } from './kiosk-tokens.js';
import { createTokenService } from './tokens.js';

const SECRET = 'a-valid-secret-of-at-least-32-characters-long';
const NOW = new Date('2026-10-18T03:00:00.250Z');
const TENANT = 'c38a2e12-88f5-4f32-843e-90cb6d88f9a1';
const LOCATION = '5b1f0c7e-2d4a-4e6b-9a51-7c3f8e2d1a90';

describe('signKioskToken', () => {
  it('signs a 30-day KIOSK_DISPLAY token with the location claims', async () => {
    const kiosk = await signKioskToken({
      secret: SECRET,
      tenantId: TENANT,
      locationId: LOCATION,
      now: NOW,
    });

    const { payload } = await jwtVerify(kiosk.token, new TextEncoder().encode(SECRET), {
      issuer: 'antre-auth',
      audience: 'antre-api',
      currentDate: NOW,
    });
    expect(payload).toMatchObject({
      sub: kiosk.tokenId,
      role: 'KIOSK_DISPLAY',
      tenant_id: TENANT,
      location_id: LOCATION,
      iat_ms: NOW.getTime(),
    });
    expect(payload.exp! - payload.iat!).toBe(30 * 24 * 60 * 60);
    expect(kiosk.expiresAt.getTime()).toBe(payload.exp! * 1000);
  });

  it('is not accepted by the user token verifier', async () => {
    const kiosk = await signKioskToken({
      secret: SECRET,
      tenantId: TENANT,
      locationId: LOCATION,
      now: NOW,
    });
    const users = createTokenService({ secret: SECRET, now: () => NOW });
    expect(await users.verify(kiosk.token)).toBeNull();
  });
});

describe('FanoutEventPublisher', () => {
  it('publishes to every publisher and rethrows the first failure afterwards', async () => {
    const first = new InMemoryEventPublisher();
    const second = new InMemoryEventPublisher();
    const failing = {
      publish: async () => {
        throw new Error('redis down');
      },
    };
    const event = createEvent('queue.ticket.cancelled', {
      tenant: { id: TENANT, name: 'Klinik' },
      location: { id: LOCATION, code: 'pusat' },
      data: {
        ticket_id: '9e2c4b1a-6f3d-4c8e-b2a7-1d5f9e0c3b42',
        ticket_number: 'A-001',
        customer_name: 'Budi',
        customer_phone: null,
        status: 'CANCELLED',
      },
    });

    await expect(new FanoutEventPublisher([first, failing, second]).publish(event)).rejects.toThrow(
      'redis down',
    );
    expect(first.events).toEqual([event]);
    expect(second.events).toEqual([event]);
  });
});

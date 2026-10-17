import { describe, expect, it } from 'vitest';

import {
  EVENT_EXCHANGE,
  EVENT_TYPES,
  createEvent,
  createEventId,
  type EventData,
  eventDataSchemas,
  parseEvent,
  safeParseEvent,
} from './index.js';

const tenant = { id: 'c38a2e12-88f5-4f32-843e-90cb6d88f9a1', name: 'Klinik Pratama Sehat Bersama' };
const location = { id: '5b1f0c7e-2d4a-4e6b-9a51-7c3f8e2d1a90', code: 'pusat' };

const calledExample = {
  event_id: 'evt-8f921d3e',
  event_type: 'queue.ticket.called',
  schema_version: 1,
  timestamp: '2026-10-09T10:15:30Z',
  tenant,
  location,
  data: {
    ticket_id: '9e2c4b1a-6f3d-4c8e-b2a7-1d5f9e0c3b42',
    ticket_number: 'A-012',
    status: 'CALLED',
    is_recall: false,
    customer_name: 'Budi Santoso',
    customer_phone: '6281234567890',
    resource_name: 'Poli Umum - dr. Siska',
    called_at: '2026-10-09T10:15:30Z',
  },
};

const messageExample = {
  event_id: 'evt-1a2b3c4d',
  event_type: 'wa.message.received',
  schema_version: 1,
  timestamp: '2026-10-09T10:14:58Z',
  tenant: null,
  location: null,
  data: {
    wamid: 'wamid.HBgNNjI4MTIzNDU2Nzg5MA',
    from: '6281234567890',
    profile_name: 'Budi Santoso',
    type: 'text',
    text: 'ANTRE klinik-sehat pusat',
    reply_id: null,
  },
};

const statusEvent = {
  event_id: 'evt-1a2b3c4e',
  event_type: 'wa.status.received',
  schema_version: 1,
  timestamp: '2026-10-09T10:16:00Z',
  tenant: null,
  location: null,
  data: {
    wamid: 'wamid.X',
    status: 'DELIVERED',
    status_at: '2026-10-09T10:16:00Z',
    recipient: '6281234567890',
  },
};

const replyEvent = {
  event_id: 'evt-1a2b3c4f',
  event_type: 'wa.reply.requested',
  schema_version: 1,
  timestamp: '2026-10-09T10:16:00Z',
  tenant: null,
  location: null,
  data: { to: '6281234567890', message: { kind: 'text', body: 'Halo' } },
};

describe('catalog', () => {
  it('has the 20 routing keys of spec 7.1, each with a payload schema', () => {
    expect(EVENT_TYPES).toHaveLength(20);
    expect(new Set(EVENT_TYPES).size).toBe(20);
    for (const type of EVENT_TYPES) {
      expect(eventDataSchemas[type]).toBeDefined();
    }
    expect(EVENT_EXCHANGE).toBe('antre.events');
  });
});

describe('parseEvent', () => {
  it('accepts the spec examples', () => {
    expect(parseEvent(calledExample).event_type).toBe('queue.ticket.called');
    expect(parseEvent(messageExample).event_type).toBe('wa.message.received');
    expect(parseEvent(statusEvent).event_type).toBe('wa.status.received');
  });

  it('strips unknown keys', () => {
    const parsed = parseEvent({ ...calledExample, extra: 1 });
    expect('extra' in parsed).toBe(false);
  });

  it('rejects a scoped event with a null tenant', () => {
    expect(safeParseEvent({ ...calledExample, tenant: null }).success).toBe(false);
    expect(safeParseEvent({ ...calledExample, location: null }).success).toBe(false);
  });

  it('rejects wa.status.received with a tenant', () => {
    expect(safeParseEvent({ ...statusEvent, tenant }).success).toBe(false);
  });

  it('handles wa.reply.requested scope', () => {
    expect(safeParseEvent(replyEvent).success).toBe(true);
    expect(safeParseEvent({ ...replyEvent, tenant }).success).toBe(true);
    expect(safeParseEvent({ ...replyEvent, tenant, location }).success).toBe(true);
    expect(safeParseEvent({ ...replyEvent, location }).success).toBe(false);
  });

  it('enforces WhatsApp message shapes', () => {
    const button = { id: 'b', title: 'Ya' };
    const buttons = (count: number) => ({
      ...replyEvent,
      data: {
        to: '6281234567890',
        message: { kind: 'buttons', body: 'Pilih', buttons: Array(count).fill(button) },
      },
    });
    expect(safeParseEvent(buttons(3)).success).toBe(true);
    expect(safeParseEvent(buttons(4)).success).toBe(false);
    expect(safeParseEvent(buttons(0)).success).toBe(false);
  });

  it('rejects schema_version 2 and zoneless timestamps', () => {
    expect(safeParseEvent({ ...calledExample, schema_version: 2 }).success).toBe(false);
    expect(safeParseEvent({ ...calledExample, timestamp: '2026-10-09T10:15:30' }).success).toBe(
      false,
    );
  });

  it('rejects an unknown event type and a mismatched payload', () => {
    expect(safeParseEvent({ ...calledExample, event_type: 'queue.ticket.unknown' }).success).toBe(
      false,
    );
    expect(
      safeParseEvent({ ...calledExample, data: { ...calledExample.data, status: 'SERVING' } })
        .success,
    ).toBe(false);
  });
});

describe('createEvent', () => {
  it('builds a valid envelope with a fresh event id', () => {
    const event = createEvent(
      'queue.ticket.called',
      { tenant, location, data: calledExample.data as EventData<'queue.ticket.called'> },
      { now: new Date('2026-10-09T10:15:30.123Z') },
    );
    expect(event.event_id).toMatch(/^evt-[0-9a-f-]{8,36}$/);
    expect(event.timestamp).toBe('2026-10-09T10:15:30Z');
    expect(event.schema_version).toBe(1);
    expect(createEventId()).toMatch(/^evt-[0-9a-f-]{8,36}$/);
  });

  it('throws when the payload violates the contract', () => {
    expect(() =>
      createEvent('queue.ticket.called', {
        tenant,
        location,
        data: { ...calledExample.data, ticket_number: 'bad' } as EventData<'queue.ticket.called'>,
      }),
    ).toThrow();
  });
});

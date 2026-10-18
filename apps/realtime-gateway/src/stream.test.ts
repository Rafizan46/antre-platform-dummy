import type { RealtimeUpdate } from '@antre/messaging/realtime';
import { describe, expect, it } from 'vitest';

import { parseSseBlock } from '../test/sse-client.js';
import { Broadcaster } from './broadcaster.js';
import { silentLogger } from './logger.js';
import { METRIC_NAMES, Metrics } from './metrics.js';
import { SseStream, sseEvent, type CloseReason, type SseSink } from './stream.js';
import { FakeStore } from '../test/fake-store.js';

class Sink implements SseSink {
  chunks: string[] = [];
  ended = false;
  writableLength = 0;
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  end(): void {
    this.ended = true;
  }
  events() {
    return this.chunks
      .map((chunk) => parseSseBlock(chunk.trimEnd()).message)
      .filter((message) => message !== undefined);
  }
}

const TENANT_A = 'c38a2e12-88f5-4f32-843e-90cb6d88f9a1';
const TENANT_B = '0f8f5a0e-6a43-4c55-9d0e-0d7a8b1c2e3f';
const LOCATION = '5b1f0c7e-2d4a-4e6b-9a51-7c3f8e2d1a90';

function update(number: string): RealtimeUpdate {
  return {
    type: 'queue.ticket.called',
    event_id: `evt-${number}`,
    at: '2026-10-18T03:00:00Z',
    location_id: LOCATION,
    status: 'CALLED',
    ticket_number: number,
    resource_name: 'Loket 1',
    is_recall: false,
  };
}

function stream(
  sink: Sink,
  identity: Partial<SseStream['identity']> = {},
  maxBufferedBytes = 1_000_000,
) {
  return new SseStream(
    sink,
    { tenantId: TENANT_A, locationId: LOCATION, kind: 'staff', kioskIssuedAtMs: null, ...identity },
    maxBufferedBytes,
  );
}

describe('sseEvent', () => {
  it('formats id, event, and one data line', () => {
    expect(sseEvent('update', { a: 1 }, '5-0')).toBe('id: 5-0\nevent: update\ndata: {"a":1}\n\n');
    expect(sseEvent('snapshot', { updates: [] })).toBe('event: snapshot\ndata: {"updates":[]}\n\n');
  });
});

describe('SseStream', () => {
  it('buffers live updates during the replay and drops the ones already replayed', () => {
    const sink = new Sink();
    const s = stream(sink);
    s.open(3000);
    s.deliver('3-0', update('A-003'));
    s.deliver('4-0', update('A-004'));
    s.sendReplay('1-0', [
      { id: '2-0', update: update('A-002') },
      { id: '3-0', update: update('A-003') },
    ]);
    s.goLive();
    s.deliver('4-0', update('A-004'));
    s.deliver('5-0', update('A-005'));

    expect(sink.chunks[0]).toBe('retry: 3000\n\n');
    expect(sink.events().map((m) => m.id)).toEqual(['2-0', '3-0', '4-0', '5-0']);
  });

  it('sends a snapshot whose id resumes the live updates', () => {
    const sink = new Sink();
    const s = stream(sink);
    s.deliver('2-0', update('A-002'));
    s.sendSnapshot([
      { id: '1-0', update: update('A-001') },
      { id: '2-0', update: update('A-002') },
    ]);
    s.goLive();

    const events = sink.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'snapshot', id: '2-0' });
    expect((events[0]!.data as { updates: unknown[] }).updates).toHaveLength(2);
  });

  it('closes a client whose socket buffer exceeds the limit', () => {
    const sink = new Sink();
    const reasons: CloseReason[] = [];
    const s = stream(sink, {}, 10);
    s.onClose((reason) => reasons.push(reason));
    s.goLive();
    sink.writableLength = 11;
    s.deliver('1-0', update('A-001'));

    expect(s.closed).toBe(true);
    expect(sink.ended).toBe(true);
    expect(reasons).toEqual(['slow_client']);
    s.deliver('2-0', update('A-002'));
    expect(sink.chunks).toHaveLength(1);
  });

  it('writes heartbeat comments', () => {
    const sink = new Sink();
    stream(sink).heartbeat();
    expect(sink.chunks).toEqual([': ping\n\n']);
  });
});

describe('Broadcaster', () => {
  function setup(limits = { maxConnections: 10, maxConnectionsPerTenant: 2 }) {
    const store = new FakeStore();
    const metrics = new Metrics();
    const broadcaster = new Broadcaster({ store, metrics, log: silentLogger, ...limits });
    return { store, metrics, broadcaster };
  }

  it('fans out a channel to its streams only and subscribes once per channel', async () => {
    const { store, broadcaster } = setup();
    const a1 = new Sink();
    const a2 = new Sink();
    const b = new Sink();
    const streams = [stream(a1), stream(a2), stream(b, { tenantId: TENANT_B })];
    for (const s of streams) {
      await broadcaster.add(s);
      s.goLive();
    }
    expect([...store.listeners.keys()].sort()).toEqual(
      [`rt:${TENANT_A}:${LOCATION}`, `rt:${TENANT_B}:${LOCATION}`].sort(),
    );

    store.publish('log', `rt:${TENANT_A}:${LOCATION}`, update('A-001'));

    expect(a1.events()).toHaveLength(1);
    expect(a2.events()).toHaveLength(1);
    expect(b.events()).toHaveLength(0);
  });

  it('unsubscribes with the last stream and frees the tenant slots', async () => {
    const { store, broadcaster, metrics } = setup();
    const s1 = stream(new Sink());
    const s2 = stream(new Sink());
    await broadcaster.add(s1);
    await broadcaster.add(s2);
    expect(broadcaster.admission(TENANT_A)).toBe('tenant_limit');
    expect(broadcaster.admission(TENANT_B)).toBe('ok');

    s1.close('client_closed');
    expect(store.unsubscribed).toEqual([]);
    s2.close('client_closed');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.unsubscribed).toEqual([`rt:${TENANT_A}:${LOCATION}`]);
    expect(broadcaster.connections).toBe(0);
    expect(broadcaster.admission(TENANT_A)).toBe('ok');
    expect(metrics.total(METRIC_NAMES.clientsClosed, { reason: 'client_closed' })).toBe(2);
  });

  it('enforces the global limit', async () => {
    const { broadcaster } = setup({ maxConnections: 1, maxConnectionsPerTenant: 5 });
    await broadcaster.add(stream(new Sink()));
    expect(broadcaster.admission(TENANT_B)).toBe('global_limit');
  });

  it('closes kiosk streams issued before a revocation, not staff or newer kiosk streams', async () => {
    const { store, broadcaster } = setup({ maxConnections: 10, maxConnectionsPerTenant: 10 });
    const oldKiosk = stream(new Sink(), { kind: 'kiosk', kioskIssuedAtMs: 1_000 });
    const newKiosk = stream(new Sink(), { kind: 'kiosk', kioskIssuedAtMs: 3_000 });
    const staff = stream(new Sink());
    for (const s of [oldKiosk, newKiosk, staff]) await broadcaster.add(s);

    store.raw(
      `rt:${TENANT_A}:${LOCATION}`,
      JSON.stringify({ control: 'kiosk_revoked', revoked_at: 2_000 }),
    );

    expect(oldKiosk.closed).toBe(true);
    expect(newKiosk.closed).toBe(false);
    expect(staff.closed).toBe(false);
  });

  it('counts malformed messages and closes everything on closeAll', async () => {
    const { store, broadcaster, metrics } = setup();
    const s = stream(new Sink());
    await broadcaster.add(s);
    store.raw(`rt:${TENANT_A}:${LOCATION}`, 'garbage');
    expect(metrics.total(METRIC_NAMES.updatesReceived, { kind: 'invalid' })).toBe(1);

    broadcaster.closeAll('redis_unavailable');
    expect(s.closed).toBe(true);
    expect(broadcaster.connections).toBe(0);
  });

  it('rejects add when the subscription fails', async () => {
    const { store, broadcaster } = setup();
    store.failSubscribe = true;
    await expect(broadcaster.add(stream(new Sink()))).rejects.toThrow('subscribe failed');
  });
});

describe('Broadcaster resubscription', () => {
  it('subscribes a reopened channel only after the pending unsubscribe', async () => {
    const store = new FakeStore();
    const broadcaster = new Broadcaster({
      store,
      metrics: new Metrics(),
      log: silentLogger,
      maxConnections: 10,
      maxConnectionsPerTenant: 10,
    });
    const first = stream(new Sink());
    await broadcaster.add(first);
    first.close('client_closed');
    const sink = new Sink();
    const second = stream(sink);
    await broadcaster.add(second);
    second.goLive();

    expect(store.unsubscribed).toEqual([`rt:${TENANT_A}:${LOCATION}`]);
    store.publish('log', `rt:${TENANT_A}:${LOCATION}`, update('A-009'));
    expect(sink.events()).toHaveLength(1);
  });
});

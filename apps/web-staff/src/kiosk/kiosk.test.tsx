import type { RealtimeUpdate } from '@antre/messaging/realtime';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { announcementText, numberToWords, spokenTicketNumber } from './announce';
import { applySnapshot, applyUpdate, emptyBoard, isAnnouncement, RECENT_CALLS } from './board';
import {
  backoffDelay,
  connectRealtime,
  streamUrl,
  type ConnectionStatus,
  type EventSourceLike,
} from './connection';
import { KioskApp, KioskBoard } from './KioskApp';
import { decodeKioskToken, loadKioskIdentity, TOKEN_STORAGE_KEY } from './token';

const LOCATION = '5b1f0c7e-2d4a-4e6b-9a51-7c3f8e2d1a90';

function called(number: string, resource = 'Loket 1', extra: Partial<RealtimeUpdate> = {}) {
  return {
    type: 'queue.ticket.called',
    event_id: `evt-${number}`,
    at: '2026-10-18T03:00:00Z',
    location_id: LOCATION,
    status: 'CALLED',
    ticket_id: `id-${number}`,
    ticket_number: number,
    resource_name: resource,
    is_recall: false,
    ...extra,
  } satisfies RealtimeUpdate;
}

describe('board', () => {
  it('shows the latest number per counter and the recent calls', () => {
    let board = applyUpdate(emptyBoard, called('A-001'));
    board = applyUpdate(board, called('B-001', 'Loket 2'));
    board = applyUpdate(board, called('A-002'));

    expect(board.counters.map((c) => [c.resource, c.ticketNumber])).toEqual([
      ['Loket 1', 'A-002'],
      ['Loket 2', 'B-001'],
    ]);
    expect(board.recent.map((c) => c.ticketNumber)).toEqual(['A-002', 'B-001', 'A-001']);
  });

  it('follows serving and completion of the called ticket and ignores other updates', () => {
    let board = applyUpdate(emptyBoard, called('A-001'));
    board = applyUpdate(board, {
      ...called('A-001'),
      type: 'queue.ticket.serving',
      status: 'SERVING',
    });
    expect(board.counters[0]!.status).toBe('SERVING');
    board = applyUpdate(board, {
      type: 'queue.ticket.completed',
      event_id: 'evt-x',
      at: '2026-10-18T03:10:00Z',
      location_id: LOCATION,
      status: 'COMPLETED',
      ticket_id: 'id-A-001',
      ticket_number: 'A-001',
    });
    expect(board.counters[0]!.status).toBe('COMPLETED');
    const same = applyUpdate(board, { ...called('A-009'), type: 'booking.reservation.held' });
    expect(same).toBe(board);
  });

  it('keeps a bounded list of recent calls and rebuilds from a snapshot', () => {
    const updates = Array.from({ length: RECENT_CALLS + 3 }, (_, i) => called(`A-00${i}`));
    const board = applySnapshot(updates);
    expect(board.recent).toHaveLength(RECENT_CALLS);
    expect(board.counters).toHaveLength(1);
    expect(isAnnouncement(called('A-001'))).toBe(true);
    expect(isAnnouncement({ ...called('A-001'), type: 'queue.ticket.serving' })).toBe(false);
  });
});

describe('announcement text', () => {
  it('spells numbers in Indonesian', () => {
    expect(numberToWords(0)).toBe('nol');
    expect(numberToWords(7)).toBe('tujuh');
    expect(numberToWords(10)).toBe('sepuluh');
    expect(numberToWords(11)).toBe('sebelas');
    expect(numberToWords(12)).toBe('dua belas');
    expect(numberToWords(21)).toBe('dua puluh satu');
    expect(numberToWords(100)).toBe('seratus');
    expect(numberToWords(345)).toBe('tiga ratus empat puluh lima');
    expect(numberToWords(1012)).toBe('seribu dua belas');
  });

  it('reads the ticket number and the counter, with the recall prefix', () => {
    expect(spokenTicketNumber('A-012')).toBe('A, dua belas');
    expect(announcementText(called('A-012', 'Ruang A'))).toBe(
      'Nomor antrean A, dua belas, silakan menuju Ruang A.',
    );
    expect(announcementText(called('AB-101', 'Loket 2', { is_recall: true }))).toBe(
      'Panggilan ulang. Nomor antrean A B, seratus satu, silakan menuju Loket 2.',
    );
  });
});

class FakeEventSource implements EventSourceLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, listener);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data: unknown, lastEventId = '') {
    this.listeners.get(type)?.({ data: JSON.stringify(data), lastEventId } as MessageEvent<string>);
  }
}

describe('connectRealtime', () => {
  function setup() {
    const sources: FakeEventSource[] = [];
    const timers: { callback: () => void; ms: number }[] = [];
    const statuses: ConnectionStatus[] = [];
    const snapshots: RealtimeUpdate[][] = [];
    const updates: RealtimeUpdate[] = [];
    const connection = connectRealtime(
      {
        baseUrl: 'https://antre.test/',
        locationId: LOCATION,
        token: 'tok',
        createEventSource: (url) => {
          const source = new FakeEventSource(url);
          sources.push(source);
          return source;
        },
        setTimer: (callback, ms) => timers.push({ callback, ms }),
        clearTimer: () => undefined,
        maxBackoffMs: 4000,
      },
      {
        onSnapshot: (u) => snapshots.push(u),
        onUpdate: (u) => updates.push(u),
        onStatus: (s) => statuses.push(s),
      },
    );
    return { sources, timers, statuses, snapshots, updates, connection };
  }

  it('builds the stream URL with the token and the last event id', () => {
    expect(streamUrl('https://x/', LOCATION, 't k', null)).toBe(
      `https://x/api/v1/realtime/locations/${LOCATION}/stream?access_token=t+k`,
    );
    expect(streamUrl('', LOCATION, 't', '5-0')).toBe(
      `/api/v1/realtime/locations/${LOCATION}/stream?access_token=t&last_event_id=5-0`,
    );
    expect([0, 1, 2, 3, 10].map((n) => backoffDelay(n, 4000))).toEqual([
      1000, 2000, 4000, 4000, 4000,
    ]);
  });

  it('passes snapshots and updates through and reconnects with backoff after a refusal', () => {
    const { sources, timers, statuses, snapshots, updates, connection } = setup();
    const first = sources[0]!;
    first.onopen?.(new Event('open'));
    first.emit('snapshot', { updates: [called('A-001')] }, '1-0');
    first.emit('update', called('A-002'), '2-0');
    expect(snapshots).toHaveLength(1);
    expect(updates.map((u) => u.ticket_number)).toEqual(['A-002']);

    // EventSource retrying by itself (stream dropped): no new source.
    first.readyState = 0;
    first.onerror?.(new Event('error'));
    expect(sources).toHaveLength(1);

    // Refused (e.g. 503): closed for good, the controller opens a new one after the backoff.
    first.readyState = 2;
    first.onerror?.(new Event('error'));
    expect(first.closed).toBe(true);
    expect(timers.map((t) => t.ms)).toEqual([1000]);
    timers[0]!.callback();
    expect(sources[1]!.url).toContain('last_event_id=2-0');
    sources[1]!.readyState = 2;
    sources[1]!.onerror?.(new Event('error'));
    expect(timers.map((t) => t.ms)).toEqual([1000, 2000]);
    timers[1]!.callback();
    sources[2]!.onopen?.(new Event('open'));

    expect(statuses).toEqual([
      'connecting',
      'open',
      'reconnecting',
      'reconnecting',
      'reconnecting',
      'reconnecting',
      'reconnecting',
      'open',
    ]);
    connection.stop();
    expect(sources[2]!.closed).toBe(true);
  });
});

function kioskToken(payload: object): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${encode({ alg: 'HS256' })}.${encode(payload)}.sig`;
}

describe('kiosk token', () => {
  it('decodes the location of a KIOSK_DISPLAY token only', () => {
    const token = kioskToken({ role: 'KIOSK_DISPLAY', location_id: LOCATION, exp: 10 });
    expect(decodeKioskToken(token)).toEqual({ token, locationId: LOCATION, expiresAt: 10_000 });
    expect(decodeKioskToken(kioskToken({ role: 'OWNER', location_id: LOCATION }))).toBeNull();
    expect(decodeKioskToken('garbage')).toBeNull();
  });

  it('installs the token from the URL, strips it, and reuses the stored one', () => {
    const token = kioskToken({ role: 'KIOSK_DISPLAY', location_id: LOCATION });
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    const urls: string[] = [];
    const fromUrl = loadKioskIdentity(
      { search: `?token=${token}&x=1`, pathname: '/kiosk.html', hash: '' },
      storage,
      (url) => urls.push(url),
    );
    expect(fromUrl?.locationId).toBe(LOCATION);
    expect(urls).toEqual(['/kiosk.html?x=1']);
    expect(store.get(TOKEN_STORAGE_KEY)).toBe(token);

    const again = loadKioskIdentity(
      { search: '', pathname: '/kiosk.html', hash: '' },
      storage,
      () => {
        throw new Error('no URL change expected');
      },
    );
    expect(again?.token).toBe(token);
  });
});

describe('KioskBoard', () => {
  it('renders counters, the latest call, and the activation button', () => {
    const board = applySnapshot([called('A-001'), called('B-003', 'Loket 2')]);
    const html = renderToString(<KioskBoard board={board} status="open" audioEnabled={false} />);
    expect(html).toContain('A-001');
    expect(html).toContain('kiosk-counter kiosk-latest');
    expect(html).toContain('Terhubung');
    expect(html).toContain('mengaktifkan suara');
    expect(
      renderToString(<KioskBoard board={board} status="reconnecting" audioEnabled />),
    ).not.toContain('mengaktifkan suara');
  });

  it('explains the setup without a token', () => {
    expect(renderToString(<KioskApp identity={null} baseUrl="" />)).toContain('kiosk.html?token=');
  });
});

import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';

import { createApiClient } from './api/client';
import { ApiError, describeError } from './api/errors';
import { loginResponseSchema, type Ticket } from './api/schemas';
import { isExpired, loadSession, saveSession, SESSION_KEY, sessionFromLogin } from './auth/session';
import { applyUpdate, computeMetrics, groupByService, localDate } from './dashboard/liveState';
import { bookingActionsFor, ticketActionsFor } from './lib/actions';
import { parseHash, resolveRoute } from './lib/routes';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function client(response: Response | Error, token: string | null = 'tok') {
  const fetchImpl = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  const onUnauthorized = vi.fn();
  const api = createApiClient({
    baseUrl: 'http://api/',
    getToken: () => token,
    onUnauthorized,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { api, fetchImpl, onUnauthorized };
}

const valueSchema = z.object({ value: z.number() });

describe('api client', () => {
  it('sends the bearer token and query, and validates with the schema', async () => {
    const { api, fetchImpl } = client(json(200, { value: 1 }));
    const result = await api.get('/x', { query: { a: '1', b: undefined }, schema: valueSchema });
    expect(result).toEqual({ value: 1 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api/x?a=1');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('maps API error bodies to ApiError with Indonesian text', async () => {
    const { api } = client(json(409, { error: { code: 'INVALID_TRANSITION', message: 'x' } }));
    const failure = await api.post('/x').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe('INVALID_TRANSITION');
    expect(describeError(failure)).toContain('status saat ini');
  });

  it('signals an expired session on 401 UNAUTHORIZED but not on bad credentials', async () => {
    const expired = client(json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } }));
    await expired.api.get('/x').catch(() => undefined);
    expect(expired.onUnauthorized).toHaveBeenCalledTimes(1);

    const bad = client(json(401, { error: { code: 'INVALID_CREDENTIALS', message: 'x' } }), null);
    await bad.api.post('/login').catch(() => undefined);
    expect(bad.onUnauthorized).not.toHaveBeenCalled();
  });

  it('reports network failures and unexpected response shapes', async () => {
    const down = await client(new TypeError('fail'))
      .api.get('/x')
      .catch((e: unknown) => e);
    expect((down as ApiError).code).toBe('NETWORK');
    const odd = await client(json(200, { nope: true }))
      .api.get('/x', { schema: valueSchema })
      .catch((e: unknown) => e);
    expect((odd as ApiError).code).toBe('BAD_RESPONSE');
  });

  it('explains a suspended tenant', () => {
    const error = new ApiError(403, 'FORBIDDEN', '', { reason: 'TENANT_SUSPENDED' });
    expect(describeError(error)).toContain('ditangguhkan');
  });
});

describe('role and transition mapping', () => {
  it('offers ticket actions by status for callers only', () => {
    expect(ticketActionsFor('CALLED', 'STAFF_CALLER')).toEqual(['RECALL', 'SERVE', 'NO_SHOW']);
    expect(ticketActionsFor('SERVING', 'OWNER')).toEqual(['COMPLETE']);
    expect(ticketActionsFor('WAITING', 'OWNER')).toEqual([]);
    expect(ticketActionsFor('CALLED', 'STAFF_CASHIER')).toEqual([]);
  });

  it('offers booking actions by status for cashiers and the owner', () => {
    expect(bookingActionsFor('CONFIRMED', 'STAFF_CASHIER')).toEqual([
      'COMPLETE',
      'NO_SHOW',
      'CANCEL',
    ]);
    expect(bookingActionsFor('PENDING_PAYMENT', 'OWNER')).toEqual(['CANCEL']);
    expect(bookingActionsFor('COMPLETED', 'OWNER')).toEqual([]);
    expect(bookingActionsFor('CONFIRMED', 'STAFF_CALLER')).toEqual([]);
  });
});

describe('route guard', () => {
  it('parses hashes', () => {
    expect(parseHash('')).toEqual({ name: 'dashboard' });
    expect(parseHash('#/pengaturan/staf')).toEqual({ name: 'settings', tab: 'staf' });
    expect(parseHash('#/pengaturan/zzz')).toEqual({ name: 'not-found' });
  });

  it('redirects by session and role', () => {
    expect(resolveRoute({ name: 'dashboard' }, null)).toEqual({ name: 'login' });
    expect(resolveRoute({ name: 'register' }, null)).toBeNull();
    expect(resolveRoute({ name: 'login' }, 'OWNER')).toEqual({ name: 'dashboard' });
    expect(resolveRoute({ name: 'settings', tab: 'staf' }, 'STAFF_CASHIER')).toEqual({
      name: 'dashboard',
    });
    expect(resolveRoute({ name: 'settings', tab: 'staf' }, 'OWNER')).toBeNull();
    expect(resolveRoute({ name: 'dashboard' }, 'STAFF_CALLER')).toBeNull();
  });
});

describe('session', () => {
  const login = loginResponseSchema.parse({
    access_token: 't',
    token_type: 'Bearer',
    expires_in: 60,
    user: { id: 'u', email: 'a@b.id', role: 'OWNER', tenant_id: 'tn' },
  });

  it('round-trips through storage and drops expired or corrupt values', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const session = sessionFromLogin(login, 1000);
    expect(session.expiresAt).toBe(61_000);
    saveSession(storage, session);
    expect(loadSession(storage, 2000)).toEqual(session);
    expect(isExpired(session, 61_000)).toBe(true);
    expect(loadSession(storage, 61_000)).toBeNull();
    expect(store.has(SESSION_KEY)).toBe(false);
    store.set(SESSION_KEY, '{bad');
    expect(loadSession(storage, 0)).toBeNull();
  });
});

function ticket(id: string, status: Ticket['status'], extra: Partial<Ticket> = {}): Ticket {
  return {
    id,
    location_id: 'l',
    service_id: 's1',
    service_name: 'Umum',
    resource_id: null,
    resource_name: null,
    ticket_number: `A-${id}`,
    channel: 'STAFF',
    customer_name: 'Budi',
    status,
    recall_count: 0,
    people_ahead: null,
    called_at: null,
    serving_at: null,
    completed_at: null,
    created_at: '2026-10-18T01:00:00Z',
    ...extra,
  };
}

describe('live state', () => {
  const update = (type: string, ticketId: string, status: string) =>
    ({ type, event_id: 'e', at: 'x', location_id: 'l', status, ticket_id: ticketId }) as never;

  it('patches the status of a known ticket and asks for a refetch', () => {
    const result = applyUpdate(
      [ticket('1', 'WAITING')],
      update('queue.ticket.called', '1', 'CALLED'),
    );
    expect(result.tickets[0]?.status).toBe('CALLED');
    expect(result.needsRefresh).toBe(true);
  });

  it('asks for a refetch for unknown tickets and bookings, leaving the list alone', () => {
    const list = [ticket('1', 'WAITING')];
    expect(applyUpdate(list, update('queue.ticket.created', '9', 'WAITING')).tickets).toBe(list);
    expect(
      applyUpdate(list, update('booking.reservation.confirmed', 'b', 'CONFIRMED')).needsRefresh,
    ).toBe(true);
  });

  it('computes the daily metrics', () => {
    const metrics = computeMetrics([
      ticket('1', 'WAITING'),
      ticket('2', 'CALLED'),
      ticket('3', 'COMPLETED', {
        serving_at: '2026-10-18T01:00:00Z',
        completed_at: '2026-10-18T01:10:00Z',
      }),
      ticket('4', 'COMPLETED', {
        serving_at: '2026-10-18T02:00:00Z',
        completed_at: '2026-10-18T02:20:00Z',
      }),
    ]);
    expect(metrics).toEqual({ waiting: 1, inProgress: 1, completed: 2, averageServiceMinutes: 15 });
    expect(computeMetrics([]).averageServiceMinutes).toBeNull();
  });

  it('groups by service with active tickets first, and formats the local date', () => {
    const groups = groupByService([
      ticket('2', 'COMPLETED'),
      ticket('1', 'CALLED'),
      ticket('3', 'WAITING'),
    ]);
    expect(groups[0]?.tickets.map((t) => t.id)).toEqual(['1', '3', '2']);
    expect(localDate(new Date('2026-10-17T20:00:00Z'), 'Asia/Jakarta')).toBe('2026-10-18');
  });
});

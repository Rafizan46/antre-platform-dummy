// Realtime SSE Gateway for the staff dashboard and the Kiosk TV (spec sections 3.6, 5.1, and 8):
// GET /api/v1/realtime/locations/:location_id/stream (OWNER, STAFF_*, KIOSK_DISPLAY), /healthz,
// /readyz (503 while Redis is down), and /metrics. Customers never use SSE (WhatsApp only).
// The Fastify request log is off: the token travels in the query string (?access_token=), so
// only the service logger writes, with tenant and location ids but never the token.
import {
  compareStreamIds,
  isStreamId,
  kioskRevokedKey,
  realtimeLogKey,
} from '@antre/messaging/realtime';
import { uuidSchema } from '@antre/shared-types';
import Fastify, { type FastifyReply } from 'fastify';

import type { Principal, TokenVerifier } from './auth.js';
import { extractToken } from './auth.js';
import type { Broadcaster } from './broadcaster.js';
import type { RealtimeConfig } from './config.js';
import type { Logger } from './logger.js';
import { METRIC_NAMES, type Metrics } from './metrics.js';
import type { RealtimeStore } from './store.js';
import { SseStream } from './stream.js';

const REQUEST_TIMEOUT_MS = 15_000;
const HEADERS_TIMEOUT_MS = 10_000;

const locationIdSchema = uuidSchema.transform((value) => value.toLowerCase());

export const STREAM_PATH = '/api/v1/realtime/locations/:location_id/stream';

export interface AppDeps {
  config: Pick<
    RealtimeConfig,
    'retryMs' | 'maxStreamSeconds' | 'maxBufferedBytes' | 'snapshotSize' | 'replayLimit'
  >;
  store: RealtimeStore;
  broadcaster: Broadcaster;
  tokens: TokenVerifier;
  metrics: Metrics;
  log: Logger;
  now: () => Date;
}

type ErrorCode =
  'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'RATE_LIMITED' | 'SERVICE_UNAVAILABLE';

const STATUS: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
};

function fail(
  reply: FastifyReply,
  code: ErrorCode,
  message: string,
  headers: Record<string, string> = {},
) {
  return reply.status(STATUS[code]).headers(headers).send({ error: { code, message } });
}

export function buildApp(deps: AppDeps) {
  // The request (headers, no body) must arrive within 15 s and its headers within 10 s, so a
  // slow-header client cannot hold a socket for long; both limits end once the request is
  // received, so they never cut an SSE response.
  const app = Fastify({ logger: false, requestTimeout: REQUEST_TIMEOUT_MS });
  app.server.headersTimeout = HEADERS_TIMEOUT_MS;
  const { metrics, store, broadcaster, config } = deps;

  // Generic bodies: the default handlers echo the URL, which carries ?access_token=.
  app.setNotFoundHandler((_request, reply) =>
    fail(reply, 'NOT_FOUND', 'Sumber daya tidak ditemukan.'),
  );
  app.setErrorHandler((error: { statusCode?: number }, _request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return reply.status(status).send({
        error: { code: 'BAD_REQUEST', message: 'Permintaan tidak valid.' },
      });
    }
    deps.log.error({ status }, 'request failed');
    return reply
      .status(500)
      .send({ error: { code: 'INTERNAL_ERROR', message: 'Terjadi kesalahan internal.' } });
  });
  const result = (value: string) =>
    metrics.increment(METRIC_NAMES.streamRequests, { result: value });

  // Graceful shutdown: open streams end before the server closes, so clients reconnect elsewhere.
  app.addHook('preClose', async () => {
    broadcaster.closeAll('shutdown');
  });

  app.get('/healthz', async () => ({ status: 'ok', service: 'realtime-gateway' }));

  app.get('/readyz', async (_request, reply) => {
    const ready = store.ready;
    return reply
      .status(ready ? 200 : 503)
      .send({ status: ready ? 'ready' : 'unavailable', redis: ready });
  });

  app.get('/metrics', async (_request, reply) =>
    reply.type('text/plain; version=0.0.4').send(metrics.render()),
  );

  app.get<{ Params: { location_id: string }; Querystring: Record<string, unknown> }>(
    STREAM_PATH,
    async (request, reply) => {
      // Lower case: the channel and log keys are built from it (an upper-case UUID would
      // otherwise subscribe to an empty channel).
      const locationId = locationIdSchema.safeParse(request.params.location_id);
      if (!locationId.success) {
        result('not_found');
        return fail(reply, 'NOT_FOUND', 'Lokasi tidak ditemukan.');
      }
      const token = extractToken(request.query, request.headers.authorization);
      const principal: Principal | null = token === null ? null : await deps.tokens.verify(token);
      if (principal === null) {
        result('unauthorized');
        return fail(reply, 'UNAUTHORIZED', 'Autentikasi diperlukan atau token tidak valid.');
      }
      if (
        principal.kind === 'other' ||
        (principal.kind === 'kiosk' && principal.locationId !== locationId.data)
      ) {
        result('forbidden');
        return fail(reply, 'FORBIDDEN', 'Anda tidak memiliki akses ke sumber daya ini.');
      }
      if (!store.ready) {
        result('unavailable');
        return fail(reply, 'SERVICE_UNAVAILABLE', 'Layanan realtime sedang tidak tersedia.', {
          'retry-after': '5',
        });
      }
      const tenantId = principal.tenantId;
      if (principal.kind === 'kiosk') {
        let revokedAt: number | null;
        try {
          revokedAt = await store.kioskRevokedAt(kioskRevokedKey(tenantId, locationId.data));
        } catch {
          result('unavailable');
          return fail(reply, 'SERVICE_UNAVAILABLE', 'Layanan realtime sedang tidak tersedia.', {
            'retry-after': '5',
          });
        }
        if (revokedAt !== null && principal.issuedAtMs <= revokedAt) {
          result('unauthorized');
          return fail(reply, 'UNAUTHORIZED', 'Token kiosk sudah dicabut.');
        }
      }
      if (broadcaster.admission(tenantId) !== 'ok') {
        result('limited');
        return fail(reply, 'RATE_LIMITED', 'Terlalu banyak koneksi realtime.', {
          'retry-after': '30',
        });
      }

      result('accepted');
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const stream = new SseStream(
        raw,
        {
          tenantId,
          locationId: locationId.data,
          kind: principal.kind,
          kioskIssuedAtMs: principal.kind === 'kiosk' ? principal.issuedAtMs : null,
        },
        config.maxBufferedBytes,
        (event) => metrics.increment(METRIC_NAMES.eventsSent, { event }),
      );
      const lifetimeMs = Math.min(
        config.maxStreamSeconds * 1000,
        principal.expiresAt - deps.now().getTime(),
      );
      const expiry = setTimeout(() => stream.close('expired'), Math.max(lifetimeMs, 0));
      stream.onClose((reason) => {
        clearTimeout(expiry);
        deps.log.debug(
          { tenant_id: tenantId, location_id: locationId.data, kind: principal.kind, reason },
          'stream closed',
        );
      });
      request.raw.on('close', () => stream.close('client_closed'));
      raw.on('error', () => stream.close('error'));
      stream.open(config.retryMs);

      const lastEventId = readLastEventId(request.headers['last-event-id'], request.query);
      try {
        await broadcaster.add(stream);
        if (stream.closed) return;
        const logKey = realtimeLogKey(tenantId, locationId.data);
        await sendBacklog(stream, store, logKey, lastEventId, config);
        stream.goLive();
        deps.log.debug(
          { tenant_id: tenantId, location_id: locationId.data, kind: principal.kind },
          'stream opened',
        );
      } catch (error) {
        deps.log.warn({ err: error, tenant_id: tenantId }, 'stream setup failed');
        stream.close('redis_unavailable');
      }
    },
  );

  return app;
}

function readLastEventId(header: string | string[] | undefined, query: unknown): string | null {
  const value =
    typeof header === 'string'
      ? header
      : (query as { last_event_id?: unknown } | null)?.last_event_id;
  return typeof value === 'string' && isStreamId(value) ? value : null;
}

/** Replay after Last-Event-ID when the log still covers it, a snapshot otherwise. */
async function sendBacklog(
  stream: SseStream,
  store: RealtimeStore,
  logKey: string,
  lastEventId: string | null,
  config: AppDeps['config'],
): Promise<void> {
  if (lastEventId !== null) {
    const oldest = await store.oldestId(logKey);
    if (oldest !== null && compareStreamIds(lastEventId, oldest) >= 0) {
      const entries = await store.entriesAfter(logKey, lastEventId, config.replayLimit + 1);
      if (entries.length <= config.replayLimit) {
        stream.sendReplay(lastEventId, entries);
        return;
      }
    }
  }
  stream.sendSnapshot(await store.latest(logKey, config.snapshotSize));
}

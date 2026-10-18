// Meta webhook (FR-WA-02, spec section 5.2): GET verifies the subscription, POST receives
// notifications. POST only verifies, deduplicates, and publishes, then answers 200 at once:
//   1. X-Hub-Signature-256 over the raw body (401 when invalid), before anything else;
//   2. the broker must be reachable, otherwise 503 so that Meta delivers the notification again
//      (a dedup key is never written for a message that was not published);
//   3. messages[] are deduplicated per wamid (SET wa:msg:{wamid} 1 NX EX 86400) and published as
//      wa.message.received; statuses[] are published as wa.status.received (tenant = null).
// The conversation itself runs in the wa.inbound consumer. The parser applies to this scope only.
import { createEvent, type EventEnvelope } from '@antre/event-contracts';
import type { FastifyPluginAsync } from 'fastify';

import { maskPhone, type Logger } from '../logger.js';
import { METRIC_NAMES, type Metrics } from '../metrics.js';
import { KEYS, StoreUnavailableError, type KeyValueStore } from '../store.js';
import { extractWebhook } from './payload.js';
import { SIGNATURE_HEADER, secretMatches, verifySignature } from './signature.js';

/** Meta notifications are small (media arrive as ids); larger bodies are refused with 413. */
export const WEBHOOK_BODY_LIMIT = 256 * 1024;
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const CHALLENGE_PATTERN = /^[A-Za-z0-9._-]{1,256}$/;

export interface EventSink {
  readonly connected: boolean;
  publish(event: EventEnvelope): Promise<void>;
}

export interface WebhookDeps {
  verifyToken: string;
  appSecret: string;
  phoneNumberId: string | null;
  events: EventSink;
  store: KeyValueStore;
  log: Logger;
  metrics: Metrics;
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

/** First delivery of `wamid`? Redis down = treat as new (the consumer deduplicates again). */
async function firstDelivery(deps: WebhookDeps, wamid: string): Promise<boolean> {
  try {
    return await deps.store.setIfAbsent(KEYS.webhookDedup(wamid), '1', DEDUP_TTL_MS);
  } catch (error) {
    if (!(error instanceof StoreUnavailableError)) throw error;
    deps.log.warn({ err: error }, 'webhook dedup unavailable; message published anyway');
    return true;
  }
}

export const webhookRoutes: FastifyPluginAsync<{ deps: WebhookDeps }> = async (app, { deps }) => {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT },
    (_request, body, done) => done(null, body),
  );

  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/webhook',
    async (request, reply) => {
      const mode = request.query['hub.mode'];
      const token = request.query['hub.verify_token'];
      const challenge = request.query['hub.challenge'];
      if (
        mode !== 'subscribe' ||
        typeof token !== 'string' ||
        typeof challenge !== 'string' ||
        !CHALLENGE_PATTERN.test(challenge) ||
        !secretMatches(token, deps.verifyToken)
      ) {
        deps.log.warn(
          { mode: typeof mode === 'string' ? mode : null },
          'webhook verification refused',
        );
        return reply.status(403).send(errorBody('FORBIDDEN', 'Verifikasi webhook ditolak.'));
      }
      deps.log.info({}, 'webhook verified');
      return reply.type('text/plain; charset=utf-8').send(challenge);
    },
  );

  app.post('/webhook', async (request, reply) => {
    const raw = request.body;
    if (!Buffer.isBuffer(raw)) {
      deps.metrics.increment(METRIC_NAMES.webhookRequests, { result: 'invalid' });
      return reply
        .status(415)
        .send(errorBody('VALIDATION_ERROR', 'Content-Type harus application/json.'));
    }
    if (!verifySignature(raw, request.headers[SIGNATURE_HEADER], deps.appSecret)) {
      deps.metrics.increment(METRIC_NAMES.webhookRequests, { result: 'unauthorized' });
      deps.log.warn({ bytes: raw.length }, 'webhook signature rejected');
      return reply.status(401).send(errorBody('UNAUTHORIZED', 'Tanda tangan tidak valid.'));
    }

    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      deps.metrics.increment(METRIC_NAMES.webhookRequests, { result: 'invalid' });
      return reply.status(400).send(errorBody('VALIDATION_ERROR', 'Body bukan JSON yang valid.'));
    }
    const content = extractWebhook(json, { phoneNumberId: deps.phoneNumberId });
    if (content === null) {
      // Signed by Meta but not a WhatsApp notification (another product of the app): ignore it.
      deps.metrics.increment(METRIC_NAMES.webhookRequests, { result: 'ignored' });
      return reply.send({ status: 'ignored' });
    }
    if (content.ignored > 0) {
      deps.metrics.increment(METRIC_NAMES.inboundIgnored, {}, content.ignored);
      deps.log.info({ ignored: content.ignored }, 'webhook entries ignored');
    }
    if (content.messages.length + content.statuses.length === 0) {
      deps.metrics.increment(METRIC_NAMES.webhookRequests, { result: 'ok' });
      return reply.send({ status: 'ok' });
    }

    if (!deps.events.connected) {
      deps.metrics.increment(METRIC_NAMES.webhookRequests, { result: 'unavailable' });
      deps.log.warn(
        { messages: content.messages.length, statuses: content.statuses.length },
        'broker unavailable; webhook refused so that Meta retries',
      );
      return reply
        .status(503)
        .send(errorBody('INTERNAL_ERROR', 'Layanan sedang tidak tersedia, coba lagi.'));
    }

    for (const message of content.messages) {
      if (!(await firstDelivery(deps, message.wamid))) {
        deps.metrics.increment(METRIC_NAMES.inboundDuplicates, { stage: 'webhook' });
        deps.log.info({ wamid: message.wamid }, 'duplicate inbound message dropped');
        continue;
      }
      const event = createEvent('wa.message.received', {
        tenant: null,
        location: null,
        data: {
          wamid: message.wamid,
          from: message.from,
          profile_name: message.profileName,
          type: message.type,
          text: message.text,
          reply_id: message.replyId,
        },
      });
      await deps.events.publish(event);
      deps.metrics.increment(METRIC_NAMES.inboundPublished, { type: message.type });
      deps.log.info(
        {
          event_id: event.event_id,
          wamid: message.wamid,
          from: maskPhone(message.from),
          type: message.type,
        },
        'inbound message published',
      );
    }
    for (const status of content.statuses) {
      await deps.events.publish(
        createEvent('wa.status.received', {
          tenant: null,
          location: null,
          data: {
            wamid: status.wamid,
            status: status.status,
            status_at: status.statusAt,
            recipient: status.recipient,
          },
        }),
      );
      deps.metrics.increment(METRIC_NAMES.statusesPublished, { status: status.status });
    }
    deps.metrics.increment(METRIC_NAMES.webhookRequests, { result: 'ok' });
    return reply.send({ status: 'ok' });
  });
};

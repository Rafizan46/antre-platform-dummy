// QRIS payment callback (spec section 7.4): POST /api/v1/payments/qris/callback. It is public (no
// JWT; the payment provider calls it) and is authenticated by an HMAC-SHA256 of the raw request
// body in the X-Antre-Signature header. The signature covers the exact bytes the sender signed,
// so this scope replaces the JSON parser with a raw-buffer parser: parsing and re-serialising the
// body first would change the bytes. The parser applies to this scope only.
import { paymentCallbackSchema } from '@antre/shared-types';
import type { FastifyPluginAsync } from 'fastify';

import type { AppDeps } from '../auth/plugin.js';
import {
  handlePaymentCallback,
  runBooking,
  type PaymentCallbackResult,
} from '../booking/service.js';
import { withTransaction } from '../db/transaction.js';
import { AppError, parseOrThrow } from '../errors.js';
import { SIGNATURE_HEADER, verifySignature } from './signature.js';

const CALLBACK_BODY_LIMIT = 8 * 1024;

export const paymentRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: CALLBACK_BODY_LIMIT },
    (_request, body, done) => done(null, body),
  );

  app.post('/qris/callback', async (request, reply) => {
    const raw = request.body;
    // Anything but the raw buffer means the content type was not application/json.
    if (!Buffer.isBuffer(raw)) {
      return reply.status(415).send({
        error: { code: 'VALIDATION_ERROR', message: 'Content-Type harus application/json.' },
      });
    }
    // 1. Signature first, before anything touches the database.
    if (!verifySignature(raw, request.headers[SIGNATURE_HEADER], deps.paymentCallbackSecret)) {
      throw new AppError('UNAUTHORIZED', 'Tanda tangan tidak valid.');
    }
    // 2. and 3. Syntax and shape.
    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new AppError('VALIDATION_ERROR', 'Body bukan JSON yang valid.');
    }
    const payload = parseOrThrow(paymentCallbackSchema, json);

    if (payload.status !== 'PAID') {
      request.log.info({ payment_ref: payload.payment_ref, status: payload.status }, 'ignored');
      return reply.send({ ignored: true });
    }

    // 4. The decision table.
    const result = await runBooking<PaymentCallbackResult>(
      deps,
      request.log,
      (work) => withTransaction(deps.pool, payload.tenant_id, work),
      (client) =>
        handlePaymentCallback(
          client,
          {
            tenantId: payload.tenant_id,
            now: deps.now(),
            slotLock: deps.slotLock,
            log: request.log,
          },
          payload,
        ),
    );
    if (result.conflict !== null) {
      throw new AppError('PAYMENT_NOT_APPLICABLE', result.conflict, { details: result.body });
    }
    return result.body;
  });
};

// Signed payment callbacks (spec section 7.4): POST /api/v1/payments/qris/callback (booking DP) and,
// since S11, POST /api/v1/billing/payments/callback (location subscription). Both are public (no
// JWT; the payment provider calls them) and are authenticated by an HMAC-SHA256 of the raw request
// body in the X-Antre-Signature header. The signature covers the exact bytes the sender signed,
// so each scope replaces the JSON parser with a raw-buffer parser: parsing and re-serialising the
// body first would change the bytes. The parser applies to the callback scope only.
import { paymentCallbackSchema, type PaymentCallback } from '@antre/shared-types';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';

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

export interface SignedCallbackResult {
  body: object;
  /** Set when the callback is answered 409 PAYMENT_NOT_APPLICABLE; the changes are committed anyway. */
  conflict: string | null;
}

export type SignedCallbackHandler = (
  deps: AppDeps,
  payload: PaymentCallback,
  log: FastifyBaseLogger,
) => Promise<SignedCallbackResult>;

/**
 * A plugin with one signed callback route at `path`: signature first (401 without touching the
 * database), then JSON syntax and shape, `status` other than PAID is ignored, and `handle` applies
 * the decision table.
 */
export function signedCallbackRoutes(
  path: string,
  handle: SignedCallbackHandler,
): FastifyPluginAsync<{ deps: AppDeps }> {
  return async (app, { deps }) => {
    app.removeContentTypeParser('application/json');
    app.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: CALLBACK_BODY_LIMIT },
      (_request, body, done) => done(null, body),
    );

    app.post(path, async (request, reply) => {
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
      const result = await handle(deps, payload, request.log);
      if (result.conflict !== null) {
        throw new AppError('PAYMENT_NOT_APPLICABLE', result.conflict, { details: result.body });
      }
      return result.body;
    });
  };
}

/** Booking DP callback (S07). */
export const paymentRoutes = signedCallbackRoutes('/qris/callback', (deps, payload, log) =>
  runBooking<PaymentCallbackResult>(
    deps,
    log,
    (work) => withTransaction(deps.pool, payload.tenant_id, work),
    (client) =>
      handlePaymentCallback(
        client,
        { tenantId: payload.tenant_id, now: deps.now(), slotLock: deps.slotLock, log },
        payload,
      ),
  ),
);

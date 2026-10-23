// Callback pembayaran QRIS simulasi ber-HMAC (spec §7.4): badan JSON mentah ditandatangani
// HMAC-SHA256 dengan PAYMENT_CALLBACK_SECRET; header X-Antre-Signature: sha256=<hex>.
import { createHmac } from 'node:crypto';

export const BOOKING_CALLBACK_PATH = '/api/v1/payments/qris/callback';
export const SUBSCRIPTION_CALLBACK_PATH = '/api/v1/billing/payments/callback';

export function signBody(raw, secret) {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

/** Badan mentah + header tanda tangan + path untuk satu callback PAID. */
export function buildCallback({ paymentRef, tenantId, targetId, amount, subscription, secret }) {
  const raw = JSON.stringify({
    payment_ref: paymentRef,
    tenant_id: tenantId,
    target_id: targetId,
    amount,
    status: 'PAID',
    paid_at: new Date().toISOString(),
  });
  return {
    raw,
    signature: signBody(raw, secret),
    path: subscription ? SUBSCRIPTION_CALLBACK_PATH : BOOKING_CALLBACK_PATH,
  };
}

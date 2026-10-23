import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { buildCallback, signBody } from './pay.mjs';

const secret = 'dev-only-payment-callback-secret-not-for-prod-01';
const ids = {
  paymentRef: 'pay-1',
  tenantId: '00000000-0000-4000-8000-000000000001',
  targetId: '00000000-0000-4000-8000-000000000002',
  amount: 50000,
  secret,
};

test('signBody = sha256=<hmac hex> atas byte mentah', () => {
  const expected = createHmac('sha256', secret).update('{"a":1}').digest('hex');
  assert.equal(signBody('{"a":1}', secret), `sha256=${expected}`);
});

test('callback booking: path, isi, dan tanda tangan cocok dengan badan mentah', () => {
  const callback = buildCallback(ids);
  assert.equal(callback.path, '/api/v1/payments/qris/callback');
  const body = JSON.parse(callback.raw);
  assert.equal(body.status, 'PAID');
  assert.equal(body.payment_ref, 'pay-1');
  assert.equal(body.amount, 50000);
  assert.equal(callback.signature, signBody(callback.raw, secret));
});

test('callback langganan memakai path billing', () => {
  assert.equal(
    buildCallback({ ...ids, subscription: true }).path,
    '/api/v1/billing/payments/callback',
  );
});

// pnpm pay <payment_ref> <tenant_id> <target_id> <amount> [--subscription]
// Mengirim callback pembayaran simulasi ber-HMAC ke core-services (booking DP, atau langganan
// dengan --subscription). payment_ref ada di pesan WhatsApp DP / instruksi pembayaran langganan;
// target_id = id booking (atau id lokasi/langganan untuk --subscription).
import { loadEnv } from './lib/env.mjs';
import { buildCallback } from './lib/pay.mjs';
import { readState } from './lib/state.mjs';

const args = process.argv.slice(2);
const subscription = args.includes('--subscription');
const [paymentRef, tenantId, targetId, amountText] = args.filter((arg) => !arg.startsWith('--'));
const amount = Number(amountText);
if (!paymentRef || !tenantId || !targetId || !Number.isFinite(amount) || amount <= 0) {
  console.error('Pakai: pnpm pay <payment_ref> <tenant_id> <target_id> <amount> [--subscription]');
  process.exit(1);
}

const env = loadEnv();
const coreUrl = process.env.CORE_SERVICES_URL || readState()?.urls?.core || env.CORE_SERVICES_URL;
const secret = process.env.PAYMENT_CALLBACK_SECRET || env.PAYMENT_CALLBACK_SECRET;
const callback = buildCallback({ paymentRef, tenantId, targetId, amount, subscription, secret });

const response = await fetch(`${coreUrl}${callback.path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-antre-signature': callback.signature },
  body: callback.raw,
});
console.log(`callback: HTTP ${response.status}`);
console.log(await response.text());
process.exitCode = response.ok ? 0 : 1;

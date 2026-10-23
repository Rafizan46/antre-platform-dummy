// Shared helpers of the k6 load tests (setup of a throwaway tenant, profiles, thresholds).
import crypto from 'k6/crypto';
import http from 'k6/http';
import { fail } from 'k6';
import { Rate } from 'k6/metrics';

export const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:18080';
// /internal/v1 is never routed through the gateway, so it needs a direct URL to core-services
// (the k6 container joins the compose network, see load/README.md).
export const CORE_URL = __ENV.CORE_URL || 'http://core-services:3000';
// Setup talks to core-services directly: register and login are rate limited per IP at the gateway.
const SETUP_URL = __ENV.SETUP_URL || CORE_URL;
const SERVICE_TOKEN = __ENV.WA_CHANNEL_SERVICE_TOKEN || '';
const PAYMENT_SECRET = __ENV.PAYMENT_CALLBACK_SECRET || '';

export const JSON_HEADERS = { 'content-type': 'application/json' };

// One flag for every request that returned something the scenario did not expect (5xx, timeout,
// wrong status). Expected business answers (409 slot taken) are not errors.
export const unexpected = new Rate('antre_unexpected_responses');

// Request rates (iterations per second) of NFR-LOAD-01: quiet 5-10, normal 30-50, peak 100-150.
const PROFILES = {
  smoke: {
    stages: [
      { target: 5, duration: '10s' },
      { target: 10, duration: '20s' },
    ],
    vus: 30,
  },
  quiet: {
    stages: [
      { target: 5, duration: '15s' },
      { target: 10, duration: '30s' },
      { target: 10, duration: '45s' },
    ],
    vus: 40,
  },
  normal: {
    stages: [
      { target: 30, duration: '20s' },
      { target: 50, duration: '30s' },
      { target: 50, duration: '60s' },
    ],
    vus: 120,
  },
  peak: {
    stages: [
      { target: 100, duration: '20s' },
      { target: 150, duration: '30s' },
      { target: 150, duration: '90s' },
    ],
    vus: 400,
  },
};

export function profile() {
  const name = __ENV.PROFILE || 'smoke';
  const chosen = PROFILES[name];
  if (!chosen) fail(`unknown PROFILE ${name}; use smoke, quiet, normal, or peak`);
  return { name, ...chosen };
}

/** Scales the profile's target rate by a share of the total (e.g. 0.4 of the request mix). */
export function rampingRate(share, exec) {
  const p = profile();
  return {
    executor: 'ramping-arrival-rate',
    exec,
    startRate: 1,
    timeUnit: '1s',
    preAllocatedVUs: Math.ceil(p.vus * share),
    maxVUs: Math.ceil(p.vus * share * 2),
    stages: p.stages.map((s) => ({
      duration: s.duration,
      target: Math.max(1, Math.round(s.target * share)),
    })),
  };
}

export const apiThresholds = {
  // NFR-PERF-01: p95 < 200 ms; error rate < 1%.
  'http_req_duration{kind:api}': ['p(95)<200'],
  antre_unexpected_responses: ['rate<0.01'],
};

function post(url, body, headers = {}, tags = {}) {
  return http.post(url, JSON.stringify(body), { headers: { ...JSON_HEADERS, ...headers }, tags });
}

export function internalHeaders(tenantId) {
  return { authorization: `Bearer ${SERVICE_TOKEN}`, 'x-antre-tenant-id': tenantId };
}

export function localDate(offsetDays) {
  const ms = Date.now() + 7 * 3600 * 1000 + offsetDays * 86400 * 1000; // Asia/Jakarta, no DST
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Registers a throwaway tenant (random slug), configures one service, `resources` resources open
 * 24/7, and upgrades the location to PAID_LOCATION through the QRIS checkout and the signed
 * callback (the FREE plan allows only 100 tickets per month). Returns what the scenarios need.
 */
export function setupTenant(resources) {
  const API = SETUP_URL;
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const email = `owner-${suffix}@load.test`;
  const password = `Load-${suffix}-Pw1`;
  const reg = post(`${API}/api/v1/auth/register`, {
    tenant: {
      name: `Load ${suffix}`,
      slug: `load-${suffix}`,
      business_type: 'CLINIC',
      admin_wa_phone: '6281234567890',
    },
    location: { name: 'Pusat', code: 'pusat' },
    owner: { email, password },
  });
  if (reg.status !== 201) fail(`register failed: ${reg.status} ${reg.body}`);
  const locationId = reg.json('location.id');
  const tenantId = reg.json('tenant.id');
  const login = post(`${API}/api/v1/auth/login`, { email, password });
  if (login.status !== 200) fail(`login failed: ${login.status} ${login.body}`);
  const token = login.json('access_token');
  const auth = { authorization: `Bearer ${token}` };

  const svc = post(
    `${API}/api/v1/catalog/services`,
    { name: 'Konsultasi', ticket_prefix: 'A', avg_duration_min: 15 },
    auth,
  );
  if (svc.status !== 201) fail(`service failed: ${svc.status} ${svc.body}`);
  const serviceId = svc.json('id');
  const days = [0, 1, 2, 3, 4, 5, 6].map((d) => ({
    day_of_week: d,
    open_time: '00:00',
    close_time: '23:30',
    break_start: null,
    break_end: null,
  }));
  const hours = http.put(
    `${API}/api/v1/catalog/locations/${locationId}/operating-hours`,
    JSON.stringify({ slot_interval_min: 30, days }),
    { headers: { ...JSON_HEADERS, ...auth } },
  );
  if (hours.status !== 200) fail(`hours failed: ${hours.status} ${hours.body}`);
  const resourceIds = [];
  for (let i = 1; i <= resources; i++) {
    const res = post(
      `${API}/api/v1/catalog/resources`,
      { location_id: locationId, name: `Loket ${i}`, service_ids: [serviceId] },
      auth,
    );
    if (res.status !== 201) fail(`resource failed: ${res.status} ${res.body}`);
    resourceIds.push(res.json('id'));
  }

  const checkout = post(
    `${API}/api/v1/billing/locations/${locationId}/subscription/checkout`,
    {},
    auth,
  );
  if (checkout.status !== 201) fail(`checkout failed: ${checkout.status} ${checkout.body}`);
  const callback = JSON.stringify({
    payment_ref: checkout.json('payment.payment_ref'),
    tenant_id: tenantId,
    target_id: checkout.json('payment.target_id'),
    amount: 150000,
    status: 'PAID',
    paid_at: new Date().toISOString(),
  });
  const paid = http.post(`${API}/api/v1/billing/payments/callback`, callback, {
    headers: {
      ...JSON_HEADERS,
      'x-antre-signature': `sha256=${crypto.hmac('sha256', PAYMENT_SECRET, callback, 'hex')}`,
    },
  });
  if (paid.status !== 200) fail(`payment callback failed: ${paid.status} ${paid.body}`);

  return { tenantId, locationId, serviceId, resourceIds, token, email, password };
}

// k6 load test of the prod-like stack (spec NFR-PERF-01, NFR-LOAD-01, NFR-CONC-01).
//
//   SCENARIOS  comma list of: mixed, login, holds, sse, webhook   (default: all)
//   PROFILE    smoke | quiet | normal | peak              (default: smoke)
//
// mixed : (a) dashboard reads + (b) ticket creation through /internal/v1 and staff CALL_NEXT,
//         arrival rate ramped to the NFR-LOAD-01 rate of the profile (40% reads, 15% create, 45% call/serve/complete).
// login : (a) staff login at a low fixed rate (password hashing is CPU heavy and rate limited).
// holds : (c) many VUs hold the SAME slot; at most one hold per resource may succeed.
// sse   : (d) a few long-lived Realtime SSE connections.
// webhook: signed Meta webhook posts (WhatsApp inbound) through the gateway at 5 per second.
// See load/README.md for the docker command line.
import crypto from 'k6/crypto';
import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

import {
  BASE_URL,
  CORE_URL,
  JSON_HEADERS,
  apiThresholds,
  internalHeaders,
  localDate,
  profile,
  rampingRate,
  setupTenant,
  unexpected,
} from './lib.js';

const wanted = (__ENV.SCENARIOS || 'mixed,login,holds,sse,webhook').split(',');
const WA_APP_SECRET = __ENV.WA_APP_SECRET || '';
const RESOURCES = 2;
// Queue scenarios spread over this many tenants (one location each): a queue is serialised by its
// counter row, and a real peak is spread over many locations, not one.
const TENANTS = Number(__ENV.TENANTS || 6);
const HOLD_GROUP = 20; // concurrent attempts per slot
const HOLD_ATTEMPTS = Number(__ENV.HOLD_ATTEMPTS || 400);
const HOLD_VUS = 40;
const SSE_CONNECTIONS = Number(__ENV.SSE_CONNECTIONS || 25);
const SSE_SECONDS = Number(__ENV.SSE_SECONDS || 20);

export const holdsAccepted = new Counter('antre_holds_accepted');
export const holdsRejected = new Counter('antre_holds_rejected_conflict');
export const doubleBookings = new Counter('antre_double_bookings');
export const ticketsCreated = new Counter('antre_tickets_created');
export const ticketsCalled = new Counter('antre_tickets_called');

const all = {
  mixed: {
    // Iteration shares of the profile rate: 0.4 + 0.15 + 3 x 0.15 = 1.0 request/s per unit.
    reads: rampingRate(0.4, 'reads'),
    create: rampingRate(0.15, 'createTicket'),
    call: rampingRate(0.15, 'callNext'),
  },
  login: {
    login: {
      executor: 'constant-arrival-rate',
      exec: 'login',
      rate: 20,
      timeUnit: '1m',
      duration: '60s',
      preAllocatedVUs: 2,
      maxVUs: 4,
    },
  },
  holds: {
    holds: {
      executor: 'shared-iterations',
      exec: 'hold',
      vus: HOLD_VUS,
      iterations: HOLD_ATTEMPTS,
      maxDuration: '2m',
    },
  },
  webhook: {
    webhook: {
      executor: 'constant-arrival-rate',
      exec: 'webhook',
      rate: 5,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 10,
      maxVUs: 30,
    },
  },
  sse: {
    sse: {
      executor: 'per-vu-iterations',
      exec: 'sse',
      vus: SSE_CONNECTIONS,
      iterations: 1,
      maxDuration: `${SSE_SECONDS + 20}s`,
    },
  },
};

export const options = {
  scenarios: Object.assign({}, ...wanted.map((name) => all[name])),
  thresholds: {
    ...apiThresholds,
    // Per request name, so the summary shows each endpoint's own p50/p95/p99.
    'http_req_duration{name:GET /queues/tickets}': ['p(95)<200'],
    'http_req_duration{name:GET /bookings}': ['p(95)<200'],
    'http_req_duration{name:GET /billing/usage}': ['p(95)<200'],
    'http_req_duration{name:POST /internal/queues/tickets}': ['p(95)<200'],
    'http_req_duration{name:POST /queues/tickets/call-next}': ['p(95)<200'],
    'http_req_duration{name:POST /queues/tickets/:id/actions}': ['p(95)<200'],
    'http_req_duration{kind:hold}': ['p(95)<200'],
    'http_req_duration{kind:webhook}': ['p(95)<200'],
    // Login hashes the password on purpose (scrypt); the budget is looser than the API target.
    'http_req_duration{kind:login}': ['p(95)<500'],
    ...(wanted.includes('holds') ? { antre_double_bookings: ['count==0'] } : {}),
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const tenants = [];
  for (let i = 0; i < TENANTS; i++) tenants.push(setupTenant(RESOURCES));
  const ctx = { ...tenants[0], tenants };
  ctx.slots = [];
  if (wanted.includes('holds')) {
    ctx.date = localDate(2);
    const res = http.get(
      `${CORE_URL}/internal/v1/bookings/available-slots?location_id=${ctx.locationId}&service_id=${ctx.serviceId}&date=${ctx.date}`,
      { headers: internalHeaders(ctx.tenantId) },
    );
    ctx.slots = res.json('slots').map((s) => s.start_time);
    if (ctx.slots.length < Math.ceil(HOLD_ATTEMPTS / HOLD_GROUP))
      throw new Error(`only ${ctx.slots.length} slots on ${ctx.date}`);
  }
  console.log(`setup: ${tenants.length} tenants, ${ctx.slots.length} slots on ${ctx.date}`);
  return ctx;
}

const pickTenant = (all) => all.tenants[exec.scenario.iterationInTest % all.tenants.length];
const staff = (ctx) => ({ authorization: `Bearer ${ctx.token}` });

function record(res, okStatuses, kind = 'api') {
  const ok = okStatuses.includes(res.status);
  unexpected.add(!ok, { kind });
  return ok;
}

// (a) dashboard reads: ticket list, booking calendar, usage.
export function reads(all) {
  const ctx = pickTenant(all);
  const headers = staff(ctx);
  const pick = Math.floor(exec.scenario.iterationInTest / all.tenants.length) % 3;
  let res;
  if (pick === 0) {
    res = http.get(`${BASE_URL}/api/v1/queues/tickets?location_id=${ctx.locationId}`, {
      headers,
      tags: { kind: 'api', name: 'GET /queues/tickets' },
    });
  } else if (pick === 1) {
    res = http.get(
      `${BASE_URL}/api/v1/bookings?location_id=${ctx.locationId}&date=${localDate(2)}`,
      { headers, tags: { kind: 'api', name: 'GET /bookings' } },
    );
  } else {
    res = http.get(`${BASE_URL}/api/v1/billing/locations/${ctx.locationId}/usage`, {
      headers,
      tags: { kind: 'api', name: 'GET /billing/usage' },
    });
  }
  record(res, [200]);
}

// (b) a WhatsApp customer takes a ticket (service token, direct to core-services).
export function createTicket(all) {
  const ctx = pickTenant(all);
  const n = exec.scenario.iterationInTest;
  const phone = `62812${String(100000000 + n).padStart(9, '0')}`; // unique per iteration
  const res = http.post(
    `${CORE_URL}/internal/v1/queues/tickets`,
    JSON.stringify({
      location_id: ctx.locationId,
      service_id: ctx.serviceId,
      customer_phone: phone,
      customer_name: `Pelanggan ${n}`,
    }),
    {
      headers: { ...JSON_HEADERS, ...internalHeaders(ctx.tenantId) },
      tags: { kind: 'api', name: 'POST /internal/queues/tickets' },
    },
  );
  if (record(res, [201])) ticketsCreated.add(1);
}

// (b) staff flow on one ticket: CALL_NEXT, then SERVE and COMPLETE of the ticket just called, so the
// waiting list stays as short as in a real day (3 requests per iteration, through the gateway).
export function callNext(all) {
  const ctx = pickTenant(all);
  const resourceId = ctx.resourceIds[exec.scenario.iterationInTest % ctx.resourceIds.length];
  const headers = { ...JSON_HEADERS, ...staff(ctx) };
  const res = http.post(
    `${BASE_URL}/api/v1/queues/tickets/call-next`,
    JSON.stringify({
      location_id: ctx.locationId,
      service_id: ctx.serviceId,
      resource_id: resourceId,
    }),
    { headers, tags: { kind: 'api', name: 'POST /queues/tickets/call-next' } },
  );
  if (!record(res, [200])) return;
  const ticket = res.json('ticket');
  if (ticket === null) return;
  ticketsCalled.add(1);
  for (const action of ['SERVE', 'COMPLETE']) {
    const step = http.post(
      `${BASE_URL}/api/v1/queues/tickets/${ticket.id}/actions`,
      JSON.stringify({ action }),
      {
        headers,
        tags: { kind: 'api', name: 'POST /queues/tickets/:id/actions' },
      },
    );
    if (!record(step, [200])) return;
  }
}

// (a) login (separate tag: scrypt makes it slower by design and it is not part of the p95 target).
export function login(ctx) {
  const res = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ email: ctx.email, password: ctx.password }),
    {
      headers: JSON_HEADERS,
      tags: { kind: 'login', name: 'POST /auth/login' },
    },
  );
  record(res, [200], 'login');
  check(res, {
    'login returns a token': (r) => r.status === 200 && r.json('access_token') !== undefined,
  });
}

// (c) HOLD_GROUP consecutive attempts hit the same slot at the same time.
export function hold(ctx) {
  const n = exec.scenario.iterationInTest;
  const slot = ctx.slots[Math.floor(n / HOLD_GROUP)];
  const phone = `62813${String(100000000 + n).padStart(9, '0')}`;
  const res = http.post(
    `${CORE_URL}/internal/v1/bookings/holds`,
    JSON.stringify({
      location_id: ctx.locationId,
      service_id: ctx.serviceId,
      slot_start: slot,
      customer_name: `Tamu ${n}`,
      customer_phone: phone,
    }),
    {
      headers: { ...JSON_HEADERS, ...internalHeaders(ctx.tenantId) },
      tags: { kind: 'hold', name: 'POST /internal/bookings/holds' },
      responseCallback: http.expectedStatuses(201, 409),
    },
  );
  if (!record(res, [201, 409], 'hold')) return;
  if (res.status === 201) holdsAccepted.add(1);
  else holdsRejected.add(1);
}

// WhatsApp inbound: a signed Meta webhook payload (the text is a menu keyword, so a reply follows).
export function webhook() {
  const n = exec.scenario.iterationInTest;
  const from = `62814${String(100000000 + n).padStart(9, '0')}`;
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'W',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '628100000000', phone_number_id: '1234567890' },
              contacts: [{ wa_id: from, profile: { name: 'Load' } }],
              messages: [
                {
                  from,
                  id: `wamid.K6${Date.now().toString(36)}${n}`,
                  timestamp: '1792378800',
                  type: 'text',
                  text: { body: 'halo' },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const res = http.post(`${BASE_URL}/api/v1/channels/wa/webhook`, body, {
    headers: {
      ...JSON_HEADERS,
      'x-hub-signature-256': `sha256=${crypto.hmac('sha256', WA_APP_SECRET, body, 'hex')}`,
    },
    tags: { kind: 'webhook', name: 'POST /channels/wa/webhook' },
  });
  record(res, [200], 'webhook');
}

// (d) a long-lived SSE stream; k6 buffers the body, so the check is status and time to first byte.
export function sse(ctx) {
  const res = http.get(
    `${BASE_URL}/api/v1/realtime/locations/${ctx.locationId}/stream?access_token=${ctx.token}`,
    {
      timeout: `${SSE_SECONDS}s`,
      tags: { kind: 'sse', name: 'GET /realtime/stream' },
      responseCallback: http.expectedStatuses(200, { min: 0, max: 0 }),
    },
  );
  // Status 0 with a timeout means the stream stayed open for the whole window (the goal).
  const open = res.status === 200 || (res.status === 0 && String(res.error_code) === '1050');
  unexpected.add(!open, { kind: 'sse' });
  sleep(0);
}

// Zero double booking (NFR-CONC-01): every (resource, slot) cell holds at most one booking and
// each contended slot accepted exactly RESOURCES holds.
export function teardown(ctx) {
  if (!wanted.includes('holds')) return;
  const res = http.get(
    `${BASE_URL}/api/v1/bookings?location_id=${ctx.locationId}&date=${ctx.date}`,
    { headers: staff(ctx) },
  );
  const touched = Math.ceil(HOLD_ATTEMPTS / HOLD_GROUP);
  let booked = 0;
  let violations = 0;
  for (const slot of res.json('slots')) {
    const taken = slot.resources.filter((r) => r.booking !== null).length;
    booked += taken;
    if (taken > RESOURCES) violations += 1;
  }
  if (booked !== touched * RESOURCES) violations += 1;
  console.log(
    `holds: ${booked} booked cells for ${touched} contended slots (expected ${touched * RESOURCES})`,
  );
  doubleBookings.add(violations);
}

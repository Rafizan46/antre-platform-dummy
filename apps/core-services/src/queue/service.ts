// Queue use cases (spec sections 6.3, 7.3; FR-QUEUE-01..06). Each use case runs inside one tenant
// transaction and returns `{ result, events }`; `runQueue` publishes the events after the commit.
import { createEvent, type EventEnvelope } from '@antre/event-contracts';
import {
  TICKET_TRANSITIONS,
  formatTicketNumber,
  type ActiveTicketResponse,
  type CallNextResponse,
  type QueueTicketDto,
  type TicketChannel,
  type TicketStatus,
} from '@antre/shared-types';
import type pg from 'pg';

import type { AppDeps } from '../auth/plugin.js';
import { AppError, uniqueViolationConstraint } from '../errors.js';
import { publishAll } from '../events/publisher.js';
import {
  callOldestWaiting,
  cancelWaitingTicket,
  countPeopleAhead,
  expireStaleTickets,
  findActiveTicketId,
  findTicket,
  getCallResource,
  getLocationContext,
  getTicketService,
  insertTicket,
  lockQueue,
  markNearTurn,
  markQuotaNotified,
  nextSequence,
  reserveQuota,
  selectTickets,
  transitionTicket,
  type LocationContext,
  type StaffTicketAction,
  type TicketRow,
} from './queries.js';

const NEAR_TURN_MAX_AHEAD = 2;
const QUOTA_WARNING_RATIO = 0.8;
const MS_PER_MINUTE = 60_000;

export interface QueueEnv {
  tenantId: string;
  now: Date;
}

export interface Outcome<T> {
  result: T;
  events: EventEnvelope[];
}

interface ErrorLogger {
  error(object: object, message: string): void;
}

type Runner<T> = (work: (client: pg.PoolClient) => Promise<Outcome<T>>) => Promise<Outcome<T>>;

/** Runs a use case in a transaction (`run`), then publishes its events after the commit. */
export async function runQueue<T>(
  deps: AppDeps,
  log: ErrorLogger,
  run: Runner<T>,
  work: (client: pg.PoolClient) => Promise<Outcome<T>>,
): Promise<T> {
  let outcome: Outcome<T>;
  try {
    outcome = await run(work);
  } catch (error) {
    // Final guarantee of one active ticket per phone, location, and day (FR-QUEUE-01).
    if (uniqueViolationConstraint(error) === 'queue_tickets_active_phone_key') {
      throw new AppError('ACTIVE_TICKET_EXISTS', 'Nomor ini sudah memiliki tiket aktif hari ini.');
    }
    throw error;
  }
  await publishAll(deps.events, outcome.events, log);
  return outcome.result;
}

// Helpers

function locationNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Lokasi tidak ditemukan.');
}

function ticketNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Tiket tidak ditemukan.');
}

async function openContext(
  client: pg.PoolClient,
  locationId: string,
  now: string,
): Promise<LocationContext> {
  const context = await getLocationContext(client, locationId, now);
  if (context === null) throw locationNotFound();
  // First step of every queue operation on the location, reads included.
  await expireStaleTickets(client, locationId, now);
  return context;
}

type Audience = 'staff' | 'internal';

function estimatedServeTime(row: TicketRow, now: Date): string {
  return new Date(
    now.getTime() + row.people_ahead * row.avg_duration_min * MS_PER_MINUTE,
  ).toISOString();
}

/** `estimated_serve_time` is hidden when the tenant disabled it; `people_ahead` always stays. */
function toTicketDto(
  row: TicketRow,
  now: Date,
  context: LocationContext,
  audience: Audience,
): QueueTicketDto {
  const waiting = row.status === 'WAITING';
  const hideEstimate = audience === 'internal' && !context.show_wait_estimate;
  return {
    id: row.id,
    location_id: row.location_id,
    service_id: row.service_id,
    service_name: row.service_name,
    resource_id: row.resource_id,
    resource_name: row.resource_name,
    service_date: row.service_date,
    ticket_number: row.ticket_number,
    channel: row.channel,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    status: row.status,
    recall_count: row.recall_count,
    people_ahead: waiting ? row.people_ahead : null,
    estimated_serve_time: waiting && !hideEstimate ? estimatedServeTime(row, now) : null,
    called_at: row.called_at?.toISOString() ?? null,
    serving_at: row.serving_at?.toISOString() ?? null,
    completed_at: row.completed_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
  };
}

async function loadTicket(
  client: pg.PoolClient,
  context: LocationContext,
  id: string,
): Promise<TicketRow> {
  const rows = await selectTickets(client, context.id, context.service_date, { ids: [id] });
  const row = rows[0];
  if (row === undefined) throw ticketNotFound();
  return row;
}

function eventScope(env: QueueEnv, context: LocationContext) {
  return {
    tenant: { id: env.tenantId, name: context.tenant_name },
    location: { id: context.id, code: context.code },
  };
}

function ticketRef(row: TicketRow) {
  return {
    ticket_id: row.id,
    ticket_number: row.ticket_number,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
  };
}

function resourceNameOf(row: TicketRow): string {
  // A CALLED or SERVING ticket always has a resource.
  return row.resource_name ?? '-';
}

function calledEvent(
  env: QueueEnv,
  context: LocationContext,
  row: TicketRow,
  isRecall: boolean,
  calledAt: Date,
): EventEnvelope {
  return createEvent(
    'queue.ticket.called',
    {
      ...eventScope(env, context),
      data: {
        ...ticketRef(row),
        status: 'CALLED',
        is_recall: isRecall,
        resource_name: resourceNameOf(row),
        called_at: calledAt.toISOString(),
      },
    },
    { now: env.now },
  );
}

/** Tickets that just came within two places of their turn: mark them and build their events. */
async function nearTurnEvents(
  client: pg.PoolClient,
  env: QueueEnv,
  context: LocationContext,
  serviceId: string,
): Promise<EventEnvelope[]> {
  const ids = await markNearTurn(
    client,
    context.id,
    serviceId,
    context.service_date,
    env.now.toISOString(),
  );
  if (ids.length === 0) return [];
  const rows = await selectTickets(client, context.id, context.service_date, { ids });
  return rows.map((row) =>
    createEvent(
      'queue.ticket.near_turn',
      {
        ...eventScope(env, context),
        data: {
          ...ticketRef(row),
          status: 'WAITING',
          service_name: row.service_name,
          people_ahead: row.people_ahead,
          estimated_serve_time: toTicketDto(row, env.now, context, 'internal').estimated_serve_time,
        },
      },
      { now: env.now },
    ),
  );
}

// Use cases

export interface CreateTicketInput {
  channel: TicketChannel;
  locationId: string;
  serviceId: string;
  customerName: string;
  customerPhone: string | null;
}

export async function createTicket(
  client: pg.PoolClient,
  env: QueueEnv,
  input: CreateTicketInput,
): Promise<Outcome<QueueTicketDto>> {
  const now = env.now.toISOString();
  const context = await openContext(client, input.locationId, now);
  const audience: Audience = input.channel === 'WHATSAPP' ? 'internal' : 'staff';

  if (context.service_mode === 'RESERVATION') {
    throw new AppError('MODE_DISABLED', 'Antrean langsung tidak tersedia pada mode reservasi.');
  }
  const service = await getTicketService(client, input.serviceId, input.locationId);
  if (service === null) throw new AppError('NOT_FOUND', 'Layanan tidak ditemukan.');
  if (!context.is_active || !context.open_now) {
    throw new AppError('LOCATION_CLOSED', 'Lokasi sedang tutup.');
  }

  if (input.customerPhone !== null) {
    const activeId = await findActiveTicketId(
      client,
      context.id,
      input.customerPhone,
      context.service_date,
    );
    if (activeId !== null) {
      const existing = await loadTicket(client, context, activeId);
      throw new AppError('ACTIVE_TICKET_EXISTS', 'Nomor ini sudah memiliki tiket aktif hari ini.', {
        details: { ticket: toTicketDto(existing, env.now, context, audience) },
      });
    }
  }

  const quota = await reserveQuota(client, env.tenantId, context.id, context.period_month);
  if (quota === null) {
    throw new AppError('QUOTA_EXCEEDED', 'Kuota tiket bulanan lokasi ini sudah habis.');
  }

  const seq = await nextSequence(
    client,
    env.tenantId,
    context.id,
    service.id,
    context.service_date,
  );
  const peopleAhead = await countPeopleAhead(
    client,
    context.id,
    service.id,
    context.service_date,
    seq,
  );
  const id = await insertTicket(client, {
    tenantId: env.tenantId,
    locationId: context.id,
    serviceId: service.id,
    serviceDate: context.service_date,
    ticketNumber: formatTicketNumber(service.ticket_prefix, seq),
    channel: input.channel,
    customerName: input.customerName,
    customerPhone: input.customerPhone,
    estimatedServeTime: new Date(
      env.now.getTime() + peopleAhead * service.avg_duration_min * MS_PER_MINUTE,
    ).toISOString(),
    // Already close to the turn at creation: no separate near_turn event.
    nearTurnNotifiedAt: peopleAhead <= NEAR_TURN_MAX_AHEAD ? now : null,
    createdAt: now,
  });

  const row = await loadTicket(client, context, id);
  const dto = toTicketDto(row, env.now, context, audience);
  const events: EventEnvelope[] = [
    createEvent(
      'queue.ticket.created',
      {
        ...eventScope(env, context),
        data: {
          ...ticketRef(row),
          status: 'WAITING',
          channel: row.channel,
          service_name: row.service_name,
          people_ahead: row.people_ahead,
          estimated_serve_time: toTicketDto(row, env.now, context, 'internal').estimated_serve_time,
        },
      },
      { now: env.now },
    ),
  ];

  if (quota.monthly_ticket_quota !== null) {
    const quotaData = {
      admin_wa_phone: context.admin_wa_phone,
      plan_code: 'FREE' as const,
      period_month: context.period_month,
      ticket_count: quota.ticket_count,
      monthly_ticket_quota: quota.monthly_ticket_quota,
    };
    if (
      quota.warning_sent_at === null &&
      quota.ticket_count >= Math.ceil(QUOTA_WARNING_RATIO * quota.monthly_ticket_quota)
    ) {
      await markQuotaNotified(client, 'warning', context.id, context.period_month, now);
      events.push(
        createEvent(
          'billing.quota.warning',
          { ...eventScope(env, context), data: quotaData },
          { now: env.now },
        ),
      );
    }
    if (quota.exceeded_sent_at === null && quota.ticket_count >= quota.monthly_ticket_quota) {
      await markQuotaNotified(client, 'exceeded', context.id, context.period_month, now);
      events.push(
        createEvent(
          'billing.quota.exceeded',
          { ...eventScope(env, context), data: quotaData },
          { now: env.now },
        ),
      );
    }
  }

  return { result: dto, events };
}

export interface CallNextInput {
  locationId: string;
  serviceId: string;
  resourceId: string;
}

export async function callNext(
  client: pg.PoolClient,
  env: QueueEnv,
  input: CallNextInput,
): Promise<Outcome<CallNextResponse>> {
  const now = env.now.toISOString();
  const context = await openContext(client, input.locationId, now);
  const resource = await getCallResource(
    client,
    input.resourceId,
    input.locationId,
    input.serviceId,
  );
  if (resource === null) {
    throw new AppError('NOT_FOUND', 'Resource tidak ditemukan atau tidak melayani layanan ini.');
  }

  // No counter row means no ticket was taken today: an empty queue.
  const hasQueue = await lockQueue(client, context.id, input.serviceId, context.service_date);
  const calledId = hasQueue
    ? await callOldestWaiting(
        client,
        context.id,
        input.serviceId,
        context.service_date,
        resource.id,
        now,
      )
    : null;
  if (calledId === null) return { result: { ticket: null }, events: [] };

  const nearTurn = await nearTurnEvents(client, env, context, input.serviceId);
  const row = await loadTicket(client, context, calledId);
  return {
    result: { ticket: toTicketDto(row, env.now, context, 'staff') },
    events: [calledEvent(env, context, row, false, env.now), ...nearTurn],
  };
}

export async function applyAction(
  client: pg.PoolClient,
  env: QueueEnv,
  ticketId: string,
  action: StaffTicketAction,
): Promise<Outcome<QueueTicketDto>> {
  const now = env.now.toISOString();
  const handle = await findTicket(client, ticketId);
  if (handle === null) throw ticketNotFound();
  const context = await openContext(client, handle.location_id, now);

  const applied = await transitionTicket(
    client,
    ticketId,
    action,
    TICKET_TRANSITIONS[action].from,
    now,
  );
  if (!applied) {
    throw new AppError('INVALID_TRANSITION', 'Aksi tidak diizinkan pada status tiket saat ini.');
  }

  const row = await loadTicket(client, context, ticketId);
  const scope = eventScope(env, context);
  let event: EventEnvelope;
  switch (action) {
    case 'RECALL':
      event = calledEvent(env, context, row, true, env.now);
      break;
    case 'SERVE':
      event = createEvent(
        'queue.ticket.serving',
        {
          ...scope,
          data: {
            ...ticketRef(row),
            status: 'SERVING',
            resource_name: resourceNameOf(row),
            serving_at: env.now.toISOString(),
          },
        },
        { now: env.now },
      );
      break;
    case 'COMPLETE':
      event = createEvent(
        'queue.ticket.completed',
        {
          ...scope,
          data: { ...ticketRef(row), status: 'COMPLETED', completed_at: env.now.toISOString() },
        },
        { now: env.now },
      );
      break;
    case 'NO_SHOW':
      event = createEvent(
        'queue.ticket.no_show',
        { ...scope, data: { ...ticketRef(row), status: 'NO_SHOW' } },
        { now: env.now },
      );
      break;
  }
  return { result: toTicketDto(row, env.now, context, 'staff'), events: [event] };
}

/** WhatsApp BATAL: cancels a WAITING ticket that belongs to `customerPhone`. */
export async function cancelTicket(
  client: pg.PoolClient,
  env: QueueEnv,
  ticketId: string,
  customerPhone: string,
): Promise<Outcome<QueueTicketDto>> {
  const now = env.now.toISOString();
  const handle = await findTicket(client, ticketId, customerPhone);
  if (handle === null) throw ticketNotFound();
  const context = await openContext(client, handle.location_id, now);

  // Same mutex as CALL_NEXT, so "people ahead" cannot shift under a concurrent call.
  await lockQueue(client, context.id, handle.service_id, context.service_date);
  if (!(await cancelWaitingTicket(client, ticketId))) {
    throw new AppError(
      'INVALID_TRANSITION',
      'Hanya tiket berstatus WAITING yang dapat dibatalkan.',
    );
  }

  const nearTurn = await nearTurnEvents(client, env, context, handle.service_id);
  const row = await loadTicket(client, context, ticketId);
  const cancelled = createEvent(
    'queue.ticket.cancelled',
    { ...eventScope(env, context), data: { ...ticketRef(row), status: 'CANCELLED' } },
    { now: env.now },
  );
  return {
    result: toTicketDto(row, env.now, context, 'internal'),
    events: [cancelled, ...nearTurn],
  };
}

/** Tickets of today's operating day of the location (staff dashboard). */
export async function listTickets(
  client: pg.PoolClient,
  env: QueueEnv,
  locationId: string,
  status: TicketStatus | undefined,
): Promise<QueueTicketDto[]> {
  const context = await openContext(client, locationId, env.now.toISOString());
  const rows = await selectTickets(client, context.id, context.service_date, {
    statuses: status === undefined ? undefined : [status],
  });
  return rows.map((row) => toTicketDto(row, env.now, context, 'staff'));
}

/** WhatsApp STATUS: the active ticket of a phone at the location today. */
export async function findActive(
  client: pg.PoolClient,
  env: QueueEnv,
  locationId: string,
  customerPhone: string,
): Promise<ActiveTicketResponse> {
  const context = await openContext(client, locationId, env.now.toISOString());
  const rows = await selectTickets(client, context.id, context.service_date, {
    statuses: ['WAITING', 'CALLED', 'SERVING'],
    customerPhone,
  });
  const row = rows[0];
  return { ticket: row === undefined ? null : toTicketDto(row, env.now, context, 'internal') };
}

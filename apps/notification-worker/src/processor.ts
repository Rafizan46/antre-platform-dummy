// Processes one event: sends its WhatsApp message (logged and idempotent per tenant + event id)
// or applies a delivery status. Never throws: failures are returned for the retry policy.
//
// Idempotency: the log row is claimed (INSERT ... ON CONFLICT DO NOTHING, then SELECT ... FOR
// UPDATE) in the same transaction that calls the provider and records the wamid. A redelivered or
// duplicated event waits on the row lock and then sees SENT, so it is not sent twice. The send is
// at-least-once only in one case: the provider accepted the message but the commit failed.
import type { EventEnvelope } from '@antre/event-contracts';
import type pg from 'pg';

import {
  claimLog,
  markAttempt,
  markDeadLettered,
  markSent,
  readContext,
  updateDeliveryStatus,
  withTransaction,
} from './db.js';
import { maskPhone, type Logger } from './logger.js';
import { METRIC_NAMES, type Metrics } from './metrics.js';
import {
  buildNotification,
  fallbackContext,
  isMessageEvent,
  type MessageEventType,
} from './notifications.js';
import { describeFailure, type Failure } from './retry.js';
import type { WhatsAppAdapter } from './whatsapp/adapter.js';

export type ProcessOutcome =
  | { status: 'sent'; providerMessageId: string }
  | { status: 'duplicate' }
  | { status: 'skipped' }
  | { status: 'status-updated'; rows: number }
  | { status: 'ignored' }
  | { status: 'failed'; failure: Failure };

export interface ProcessorDeps {
  pool: pg.Pool;
  adapter: WhatsAppAdapter;
  templateLanguage: string;
  log: Logger;
  metrics: Metrics;
}

const DONE_STATUSES = new Set(['SENT', 'DELIVERED', 'READ', 'FAILED']);

export class NotificationProcessor {
  private readonly deps: ProcessorDeps;

  constructor(deps: ProcessorDeps) {
    this.deps = deps;
  }

  /** `retriesDone` = retries before this attempt (0 on the first delivery). */
  async process(event: EventEnvelope, retriesDone: number): Promise<ProcessOutcome> {
    try {
      if (event.event_type === 'wa.status.received') {
        const rows = await updateDeliveryStatus(
          this.deps.pool,
          event.data.wamid,
          event.data.status,
          event.data.status_at,
        );
        this.deps.metrics.increment(METRIC_NAMES.statusUpdates, { matched: String(rows > 0) });
        return { status: 'status-updated', rows };
      }
      if (!isMessageEvent(event)) {
        this.deps.log.warn(
          { event_id: event.event_id, event_type: event.event_type },
          'event without notification ignored',
        );
        return { status: 'ignored' };
      }
      return event.tenant === null
        ? await this.sendUntenanted(event)
        : await this.sendLogged(event, event.tenant.id, retriesDone);
    } catch (error) {
      return { status: 'failed', failure: describeFailure(error) };
    }
  }

  /** Called when a message goes to the DLQ: the log row (if any) becomes DLQ. Best effort. */
  async markDeadLettered(event: EventEnvelope, retriesDone: number): Promise<void> {
    if (event.tenant === null || !isMessageEvent(event)) return;
    try {
      await markDeadLettered(this.deps.pool, event.tenant.id, event.event_id, retriesDone);
    } catch (error) {
      this.deps.log.error(
        { err: error, event_id: event.event_id },
        'could not mark notification log as DLQ',
      );
    }
  }

  /** wa.reply.requested without a tenant: sent but not logged in notification_logs (7.1). */
  private async sendUntenanted(event: EventEnvelope<MessageEventType>): Promise<ProcessOutcome> {
    const planned = buildNotification(event, fallbackContext(event), this.deps.templateLanguage);
    if (planned === null) return this.skipped(event);
    const result = await this.deps.adapter.send(planned.message, {
      idempotencyKey: event.event_id,
    });
    this.deps.metrics.increment(METRIC_NAMES.untenantedReplies);
    this.deps.metrics.increment(METRIC_NAMES.sent, { kind: planned.message.content.kind });
    this.deps.log.info(
      {
        event_id: event.event_id,
        wamid: result.providerMessageId,
        to: maskPhone(planned.message.to),
      },
      'untenanted reply sent',
    );
    return { status: 'sent', providerMessageId: result.providerMessageId };
  }

  private async sendLogged(
    event: EventEnvelope<MessageEventType>,
    tenantId: string,
    retriesDone: number,
  ): Promise<ProcessOutcome> {
    const { adapter, templateLanguage, metrics, log } = this.deps;
    return withTransaction(this.deps.pool, tenantId, async (client) => {
      const context =
        (event.location !== null ? await readContext(client, event.location.id) : null) ??
        fallbackContext(event);
      const planned = buildNotification(event, context, templateLanguage);
      if (planned === null) return this.skipped(event);

      const content = planned.message.content;
      const row = await claimLog(client, {
        tenantId,
        eventId: event.event_id,
        recipientPhone: planned.message.to,
        templateName: planned.templateName,
        payload: {
          event_type: event.event_type,
          ...(content.kind === 'template'
            ? {
                template: content.name,
                language: content.language,
                parameters: content.parameters,
                text: content.preview,
              }
            : { message: content }),
        },
        retryCount: retriesDone,
      });
      if (DONE_STATUSES.has(row.delivery_status)) {
        metrics.increment(METRIC_NAMES.duplicates);
        log.info(
          { event_id: event.event_id, delivery_status: row.delivery_status },
          'notification already sent; duplicate ignored',
        );
        return { status: 'duplicate' } as const;
      }

      let result: { providerMessageId: string };
      try {
        result = await adapter.send(planned.message, { idempotencyKey: event.event_id });
      } catch (error) {
        // Keep the row QUEUED with the attempt count; the transaction still commits.
        await markAttempt(client, row.id, retriesDone);
        return { status: 'failed', failure: describeFailure(error) } as const;
      }
      // A failure here rolls the row back; the retry may then send again (at-least-once).
      await markSent(client, row.id, result.providerMessageId, retriesDone);
      metrics.increment(METRIC_NAMES.sent, { kind: content.kind });
      log.info(
        {
          event_id: event.event_id,
          event_type: event.event_type,
          template: planned.templateName,
          wamid: result.providerMessageId,
          to: maskPhone(planned.message.to),
          retry_count: retriesDone,
        },
        'notification sent',
      );
      return { status: 'sent', providerMessageId: result.providerMessageId } as const;
    });
  }

  private skipped(event: EventEnvelope): ProcessOutcome {
    this.deps.metrics.increment(METRIC_NAMES.skipped, { event_type: event.event_type });
    this.deps.log.debug(
      { event_id: event.event_id, event_type: event.event_type },
      'event without recipient skipped',
    );
    return { status: 'skipped' };
  }
}

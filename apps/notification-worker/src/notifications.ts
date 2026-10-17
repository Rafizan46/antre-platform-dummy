// Maps catalog events (spec section 7.1, FR-NOTIF-02..04, FR-BILLING-04/05) to the outbound
// WhatsApp message: recipient, template, and parameters. Pure: the tenant context (branding,
// location name, time zone) is read by the caller and passed in.
import type { EventEnvelope } from '@antre/event-contracts';
import type { NotificationRoutingKey } from '@antre/messaging';

import {
  DEFAULT_TIME_ZONE,
  formatDate,
  formatDateTime,
  formatPeriodMonth,
  formatRupiah,
  formatTime,
} from './format.js';
import { renderTemplate, type TemplateName, type TemplateValues } from './templates.js';
import type { OutboundMessage } from './whatsapp/adapter.js';

/** Tenant and location details shown in messages. */
export interface NotificationContext {
  tenantName: string;
  /** branding.wa_greeting (FR-AUTH-04), when set. */
  greeting: string | null;
  /** branding.labels.resource, when set (e.g. "Dokter", "Lapangan"). */
  resourceLabel: string | null;
  locationName: string;
  timeZone: string;
}

export interface PlannedNotification {
  message: OutboundMessage;
  /** null for conversation replies (notification_logs.template_name). */
  templateName: TemplateName | null;
}

/** Events that produce a message (wa.status.received updates a status instead). */
export type MessageEventType = Exclude<NotificationRoutingKey, 'wa.status.received'>;

export function isMessageEvent(event: EventEnvelope): event is EventEnvelope<MessageEventType> {
  return MESSAGE_EVENT_TYPES.has(event.event_type);
}

const MESSAGE_EVENT_TYPES: ReadonlySet<string> = new Set<MessageEventType>([
  'queue.ticket.created',
  'queue.ticket.near_turn',
  'queue.ticket.called',
  'booking.reservation.held',
  'booking.reservation.confirmed',
  'booking.reservation.expired',
  'booking.reservation.reminder_due',
  'billing.quota.warning',
  'billing.quota.exceeded',
  'billing.subscription.activated',
  'wa.reply.requested',
]);

const DEFAULT_RESOURCE_LABEL = 'Tempat';

/** Context from the envelope alone, when the location row cannot be read. */
export function fallbackContext(event: EventEnvelope): NotificationContext {
  return {
    tenantName: event.tenant?.name ?? 'Antre',
    greeting: null,
    resourceLabel: null,
    locationName: event.location?.code ?? '-',
    timeZone: DEFAULT_TIME_ZONE,
  };
}

function estimateText(iso: string | null, timeZone: string): string {
  return iso === null
    ? 'kami kabari lagi saat giliran Anda mendekat'
    : `sekitar pukul ${formatTime(iso, timeZone)}`;
}

function template<N extends TemplateName>(
  to: string,
  name: N,
  values: TemplateValues<N>,
  language: string,
): PlannedNotification {
  return { message: { to, content: renderTemplate(name, values, language) }, templateName: name };
}

/**
 * The message for `event`, or null when there is nobody to send to (a ticket entered by staff
 * without a WhatsApp number, FR-QUEUE-04).
 */
export function buildNotification(
  event: EventEnvelope<MessageEventType>,
  context: NotificationContext,
  language: string,
): PlannedNotification | null {
  const tz = context.timeZone;
  const resourceLabel = context.resourceLabel ?? DEFAULT_RESOURCE_LABEL;

  switch (event.event_type) {
    case 'queue.ticket.created': {
      const data = event.data;
      if (data.customer_phone === null) return null;
      return template(
        data.customer_phone,
        'antre_ticket_created',
        {
          customer_name: data.customer_name,
          greeting:
            context.greeting ?? `terima kasih telah mengambil antrean di ${context.tenantName}.`,
          ticket_number: data.ticket_number,
          service_name: data.service_name,
          location_name: context.locationName,
          people_ahead: String(data.people_ahead),
          estimate: estimateText(data.estimated_serve_time, tz),
        },
        language,
      );
    }
    case 'queue.ticket.near_turn': {
      const data = event.data;
      if (data.customer_phone === null) return null;
      return template(
        data.customer_phone,
        'antre_near_turn',
        {
          customer_name: data.customer_name,
          tenant_name: context.tenantName,
          ticket_number: data.ticket_number,
          service_name: data.service_name,
          people_ahead: String(data.people_ahead),
          estimate: estimateText(data.estimated_serve_time, tz),
        },
        language,
      );
    }
    case 'queue.ticket.called': {
      const data = event.data;
      if (data.customer_phone === null) return null;
      return template(
        data.customer_phone,
        'antre_ticket_called',
        {
          customer_name: data.customer_name,
          call_label: data.is_recall ? 'panggilan ulang' : 'panggilan',
          ticket_number: data.ticket_number,
          resource_name: data.resource_name,
          tenant_name: context.tenantName,
        },
        language,
      );
    }
    case 'booking.reservation.held': {
      const data = event.data;
      return template(
        data.customer_phone,
        'antre_booking_payment',
        {
          customer_name: data.customer_name,
          tenant_name: context.tenantName,
          service_name: data.service_name,
          resource_label: resourceLabel,
          resource_name: data.resource_name,
          schedule: formatDateTime(data.start_time, tz),
          dp_amount: formatRupiah(data.dp_amount),
          payment_ref: data.payment_ref,
          pay_before: formatTime(data.hold_expires_at, tz),
        },
        language,
      );
    }
    case 'booking.reservation.confirmed': {
      const data = event.data;
      return template(
        data.customer_phone,
        'antre_booking_confirmed',
        {
          customer_name: data.customer_name,
          tenant_name: context.tenantName,
          service_name: data.service_name,
          resource_label: resourceLabel,
          resource_name: data.resource_name,
          schedule: formatDateTime(data.start_time, tz),
          dp:
            data.payment_status === 'PAID' && data.dp_amount !== null
              ? `${formatRupiah(data.dp_amount)} (lunas)`
              : 'tidak ada',
        },
        language,
      );
    }
    case 'booking.reservation.expired': {
      const data = event.data;
      const paid = data.payment_status === 'PAID' || data.payment_status === 'REFUND_PENDING';
      return template(
        data.customer_phone,
        'antre_booking_expired',
        {
          customer_name: data.customer_name,
          tenant_name: context.tenantName,
          service_name: data.service_name,
          schedule: formatDateTime(data.start_time, tz),
          payment_note: paid
            ? 'pembayaran yang terlambat masuk akan dikembalikan oleh petugas'
            : 'tidak ada pembayaran yang tercatat',
        },
        language,
      );
    }
    case 'booking.reservation.reminder_due': {
      const data = event.data;
      return template(
        data.customer_phone,
        'antre_booking_reminder',
        {
          customer_name: data.customer_name,
          tenant_name: context.tenantName,
          start_time: formatTime(data.start_time, tz),
          service_name: data.service_name,
          resource_label: resourceLabel,
          resource_name: data.resource_name,
        },
        language,
      );
    }
    case 'billing.quota.warning': {
      const data = event.data;
      return template(
        data.admin_wa_phone,
        'antre_quota_warning',
        {
          tenant_name: context.tenantName,
          location_name: context.locationName,
          period: formatPeriodMonth(data.period_month),
          ticket_count: String(data.ticket_count),
          quota: String(data.monthly_ticket_quota),
        },
        language,
      );
    }
    case 'billing.quota.exceeded': {
      const data = event.data;
      return template(
        data.admin_wa_phone,
        'antre_quota_exceeded',
        {
          tenant_name: context.tenantName,
          quota: String(data.monthly_ticket_quota),
          location_name: context.locationName,
          period: formatPeriodMonth(data.period_month),
        },
        language,
      );
    }
    case 'billing.subscription.activated': {
      const data = event.data;
      return template(
        data.admin_wa_phone,
        'antre_subscription_activated',
        {
          tenant_name: context.tenantName,
          location_name: context.locationName,
          period_start: formatDate(data.current_period_start, tz),
          period_end: formatDate(data.current_period_end, tz),
          payment_ref: data.payment_ref,
        },
        language,
      );
    }
    case 'wa.reply.requested':
      return {
        message: { to: event.data.to, content: event.data.message },
        templateName: null,
      };
  }
}

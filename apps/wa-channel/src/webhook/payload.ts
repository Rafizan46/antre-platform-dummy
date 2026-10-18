// Parsing of WhatsApp Cloud API webhook notifications (FR-WA-02). The envelope is validated with
// zod; every message and status is then validated on its own, so one malformed entry never drops
// the others. Unknown fields are ignored. The sender number is the verified `from` of the
// webhook, never anything inside the message text (FR-WA-06).
import { WA_DELIVERY_UPDATES, waPhoneSchema, type WaDeliveryUpdate } from '@antre/shared-types';
import { z } from 'zod';

/** Longest inbound text kept (the WhatsApp text limit). */
export const MAX_INBOUND_TEXT = 4096;
const MAX_ID = 256;

const textSchema = z.object({ body: z.string() });
const interactiveSchema = z.object({
  type: z.string(),
  button_reply: z.object({ id: z.string().max(MAX_ID), title: z.string() }).optional(),
  list_reply: z.object({ id: z.string().max(MAX_ID), title: z.string() }).optional(),
});
// Quick reply button of a template message.
const buttonSchema = z.object({ payload: z.string().max(MAX_ID).optional(), text: z.string() });

const messageSchema = z.object({
  id: z.string().min(1).max(MAX_ID),
  from: waPhoneSchema,
  timestamp: z
    .string()
    .regex(/^[0-9]{1,12}$/)
    .optional(),
  type: z.string().min(1).max(64),
  text: textSchema.optional(),
  interactive: interactiveSchema.optional(),
  button: buttonSchema.optional(),
});

const statusSchema = z.object({
  id: z.string().min(1).max(MAX_ID),
  status: z.string(),
  timestamp: z.string().regex(/^[0-9]{1,12}$/),
  recipient_id: waPhoneSchema,
});

const contactSchema = z.object({
  wa_id: z.string().optional(),
  profile: z.object({ name: z.string().optional() }).optional(),
});

const valueSchema = z.object({
  metadata: z.object({ phone_number_id: z.string().optional() }).optional(),
  contacts: z.array(z.unknown()).optional(),
  messages: z.array(z.unknown()).optional(),
  statuses: z.array(z.unknown()).optional(),
});

const notificationSchema = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      changes: z.array(z.object({ field: z.string(), value: z.unknown() })).default([]),
    }),
  ),
});

export interface InboundMessage {
  wamid: string;
  from: string;
  profileName: string | null;
  /** Meta message type: text, interactive, button, image, ... */
  type: string;
  /** Text body, or the title of the chosen button/list row. */
  text: string | null;
  /** Id of the chosen button/list row (our option id), or a template button payload. */
  replyId: string | null;
}

export interface InboundStatus {
  wamid: string;
  status: WaDeliveryUpdate;
  statusAt: string;
  recipient: string;
}

export interface WebhookContent {
  messages: InboundMessage[];
  statuses: InboundStatus[];
  /** Entries skipped: other phone number, malformed message/status, unknown status. */
  ignored: number;
}

const STATUS_MAP: Record<string, WaDeliveryUpdate> = {
  sent: 'SENT',
  delivered: 'DELIVERED',
  read: 'READ',
  failed: 'FAILED',
};

function cleanText(value: string | undefined): string | null {
  if (value === undefined) return null;
  const text = value.slice(0, MAX_INBOUND_TEXT);
  return text.trim() === '' ? null : text;
}

function toMessage(raw: z.infer<typeof messageSchema>, names: Map<string, string>): InboundMessage {
  let text: string | null = null;
  let replyId: string | null = null;
  if (raw.type === 'text') {
    text = cleanText(raw.text?.body);
  } else if (raw.type === 'interactive') {
    const reply = raw.interactive?.button_reply ?? raw.interactive?.list_reply;
    text = cleanText(reply?.title);
    replyId = reply?.id ?? null;
  } else if (raw.type === 'button') {
    text = cleanText(raw.button?.text);
    replyId = raw.button?.payload ?? null;
  }
  const name = names.get(raw.from)?.trim();
  return {
    wamid: raw.id,
    from: raw.from,
    profileName: name ? name.slice(0, 100) : null,
    type: raw.type,
    text,
    replyId,
  };
}

/** Status timestamps are UNIX seconds. */
function toIso(seconds: string): string {
  return new Date(Number(seconds) * 1000).toISOString();
}

/**
 * Messages and statuses of a notification. Returns null when the body is not a WhatsApp
 * Business Account notification at all.
 */
export function extractWebhook(
  body: unknown,
  options: { phoneNumberId: string | null },
): WebhookContent | null {
  const parsed = notificationSchema.safeParse(body);
  if (!parsed.success || parsed.data.object !== 'whatsapp_business_account') return null;

  const content: WebhookContent = { messages: [], statuses: [], ignored: 0 };
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') continue;
      const value = valueSchema.safeParse(change.value);
      if (!value.success) {
        content.ignored += 1;
        continue;
      }
      const phoneNumberId = value.data.metadata?.phone_number_id;
      if (options.phoneNumberId !== null && phoneNumberId !== options.phoneNumberId) {
        content.ignored +=
          (value.data.messages?.length ?? 0) + (value.data.statuses?.length ?? 0) || 1;
        continue;
      }

      const names = new Map<string, string>();
      for (const rawContact of value.data.contacts ?? []) {
        const contact = contactSchema.safeParse(rawContact);
        const name = contact.success ? contact.data.profile?.name : undefined;
        if (contact.success && contact.data.wa_id && name) names.set(contact.data.wa_id, name);
      }

      for (const rawMessage of value.data.messages ?? []) {
        const message = messageSchema.safeParse(rawMessage);
        if (message.success) content.messages.push(toMessage(message.data, names));
        else content.ignored += 1;
      }
      for (const rawStatus of value.data.statuses ?? []) {
        const status = statusSchema.safeParse(rawStatus);
        const mapped = status.success ? STATUS_MAP[status.data.status] : undefined;
        if (!status.success || mapped === undefined || !WA_DELIVERY_UPDATES.includes(mapped)) {
          content.ignored += 1;
          continue;
        }
        content.statuses.push({
          wamid: status.data.id,
          status: mapped,
          statusAt: toIso(status.data.timestamp),
          recipient: status.data.recipient_id,
        });
      }
    }
  }
  return content;
}

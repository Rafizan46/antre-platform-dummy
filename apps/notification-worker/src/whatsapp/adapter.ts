// WhatsApp adapter seam (spec section 10, member 4): the worker only talks to this interface.
// Implementations: SandboxMockAdapter (dev/test, no network) and MetaCloudAdapter (Cloud API).
import type { EventData } from '@antre/event-contracts';

/** Free-form or interactive conversation reply (wa.reply.requested, 24-hour window only). */
export type ConversationMessage = EventData<'wa.reply.requested'>['message'];

/** An approved template with its positional body parameters ({{1}}, {{2}}, ...). */
export interface TemplateMessage {
  kind: 'template';
  name: string;
  language: string;
  parameters: string[];
  /** The rendered body, as the customer reads it (sandbox output and notification_logs.payload). */
  preview: string;
}

export interface OutboundMessage {
  /** E.164 digits without "+". */
  to: string;
  content: TemplateMessage | ConversationMessage;
}

export interface SendContext {
  /** Stable per logical message (the event id), so retries can be recognised. */
  idempotencyKey: string;
}

export interface SendResult {
  /** wamid returned by the Cloud API. */
  providerMessageId: string;
}

export interface WhatsAppAdapter {
  readonly name: string;
  send(message: OutboundMessage, context: SendContext): Promise<SendResult>;
}

/**
 * rate_limited and unavailable are transient (retried with backoff); rejected is permanent (the
 * request itself is wrong, e.g. unknown template or invalid recipient) and goes to the DLQ at once.
 */
export type SendFailureKind = 'rate_limited' | 'unavailable' | 'rejected';

export class WhatsAppSendError extends Error {
  readonly kind: SendFailureKind;
  readonly status: number | null;

  constructor(
    kind: SendFailureKind,
    message: string,
    options: { status?: number | null; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'WhatsAppSendError';
    this.kind = kind;
    this.status = options.status ?? null;
  }

  get retryable(): boolean {
    return this.kind !== 'rejected';
  }
}

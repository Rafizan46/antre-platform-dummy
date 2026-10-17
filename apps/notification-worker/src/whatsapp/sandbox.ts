// Sandbox WhatsApp adapter for dev and tests: no network, deterministic wamids, and scriptable
// failures (transient, rate limit, or permanent) to exercise the retry and DLQ paths.
import { createHash } from 'node:crypto';

import { maskPhone, type Logger } from '../logger.js';
import {
  WhatsAppSendError,
  type OutboundMessage,
  type SendContext,
  type SendFailureKind,
  type SendResult,
  type WhatsAppAdapter,
} from './adapter.js';

export interface SandboxSentMessage {
  message: OutboundMessage;
  idempotencyKey: string;
  providerMessageId: string;
}

export interface SandboxMockAdapterOptions {
  log?: Logger;
  /** Artificial latency per send (tests of graceful shutdown). */
  delayMs?: number;
}

/** wamid of the sandbox: derived from the idempotency key, so it is stable across restarts. */
export function sandboxMessageId(idempotencyKey: string): string {
  const digest = createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32);
  return `wamid.SANDBOX.${digest}`;
}

export class SandboxMockAdapter implements WhatsAppAdapter {
  readonly name = 'sandbox';
  /** Messages accepted, in order. */
  readonly sent: SandboxSentMessage[] = [];
  /** Every send call, including failed ones. */
  attempts = 0;
  delayMs: number;

  private readonly log: Logger | undefined;
  private scripted: SendFailureKind[] = [];
  private always: SendFailureKind | null = null;

  constructor(options: SandboxMockAdapterOptions = {}) {
    this.log = options.log;
    this.delayMs = options.delayMs ?? 0;
  }

  /** The next sends fail with these kinds, one per send, before sends succeed again. */
  failNext(...failures: SendFailureKind[]): void {
    this.scripted.push(...failures);
  }

  /** Every send fails with `failure` until called with null. */
  failAlways(failure: SendFailureKind | null): void {
    this.always = failure;
  }

  reset(): void {
    this.sent.length = 0;
    this.attempts = 0;
    this.scripted = [];
    this.always = null;
    this.delayMs = 0;
  }

  async send(message: OutboundMessage, context: SendContext): Promise<SendResult> {
    this.attempts += 1;
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));

    const failure = this.scripted.shift() ?? this.always;
    if (failure !== null) {
      const status = failure === 'rate_limited' ? 429 : failure === 'unavailable' ? 503 : 400;
      throw new WhatsAppSendError(failure, `sandbox ${failure}`, { status });
    }

    const providerMessageId = sandboxMessageId(context.idempotencyKey);
    this.sent.push({ message, idempotencyKey: context.idempotencyKey, providerMessageId });
    this.log?.info(
      {
        to: maskPhone(message.to),
        kind: message.content.kind,
        template: message.content.kind === 'template' ? message.content.name : null,
        wamid: providerMessageId,
        text: message.content.kind === 'template' ? message.content.preview : message.content.body,
      },
      'sandbox whatsapp message',
    );
    return { providerMessageId };
  }
}

// A WhatsApp customer: sends signed Meta webhooks to the WA Channel and reads the replies that the
// notification worker "delivers" through its sandbox adapter (one JSON log line per message).
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { api, signature, type ApiResponse } from './api.js';
import { eventually, stack } from './stack.js';

export interface SandboxMessage {
  to: string;
  kind: string;
  template: string | null;
  text: string;
}

/** Same masking as the worker log: first 3 digits, stars, last 4. */
export function maskPhone(phone: string): string {
  if (phone.length <= 7) return '*'.repeat(phone.length);
  return `${phone.slice(0, 3)}${'*'.repeat(phone.length - 7)}${phone.slice(-4)}`;
}

/** Every sandbox message the worker has printed so far, in order. */
export function sandboxMessages(): SandboxMessage[] {
  let content: string;
  try {
    content = readFileSync(stack().workerLog, 'utf8');
  } catch {
    return [];
  }
  const messages: SandboxMessage[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.includes('sandbox whatsapp message')) continue;
    try {
      messages.push(JSON.parse(line) as SandboxMessage);
    } catch {
      // A line cut in half while it is being written; the next poll sees it whole.
    }
  }
  return messages;
}

/**
 * A number nobody else in this run uses. The sandbox log masks numbers to their first 3 and last 4
 * digits, so the last 4 digits identify a customer: they come from a counter that is shared by all
 * test files through exclusive-create marker files next to the service logs.
 */
export function newPhone(): string {
  const directory = path.dirname(stack().workerLog);
  for (let n = 1; n < 10_000; n += 1) {
    const tail = String(n).padStart(4, '0');
    try {
      closeSync(openSync(path.join(directory, `phone-${tail}`), 'wx'));
      return `628120${String(Date.now() % 100_000).padStart(5, '0')}${tail}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('no free test phone number');
}

export class WaCustomer {
  readonly masked: string;
  private cursor = 0;

  constructor(
    readonly phone: string = newPhone(),
    private readonly appSecret: string = stack().secrets.waAppSecret,
  ) {
    this.masked = maskPhone(phone);
  }

  /** Sends one inbound text message; returns the webhook's HTTP status. */
  async send(text: string, options: { id?: string } = {}): Promise<ApiResponse> {
    const raw = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '628100000000', phone_number_id: '1234567890' },
                contacts: [{ wa_id: this.phone, profile: { name: 'Pelanggan Uji' } }],
                messages: [
                  {
                    from: this.phone,
                    id: options.id ?? `wamid.${randomUUID().replace(/-/g, '')}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: text },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    return api('POST', '/api/v1/channels/wa/webhook', {
      base: stack().waUrl,
      body: raw,
      headers: { 'x-hub-signature-256': signature(raw, this.appSecret) },
    });
  }

  /** All messages this customer received so far. */
  inbox(): SandboxMessage[] {
    return sandboxMessages().filter((message) => message.to === this.masked);
  }

  /** Waits for the next message (after the ones already consumed) that matches. */
  async nextReply(
    description: string,
    matches: (message: SandboxMessage) => boolean = () => true,
    timeoutMs = 15_000,
  ): Promise<SandboxMessage> {
    const found = await eventually(
      `a reply to ${this.masked}: ${description}`,
      () => {
        const fresh = this.inbox().slice(this.cursor);
        const index = fresh.findIndex(matches);
        if (index < 0) return undefined;
        this.cursor += index + 1;
        return fresh[index];
      },
      { timeoutMs },
    );
    return found;
  }

  /** Sends a message (webhook must answer 200) and returns the next reply. */
  async ask(text: string, timeoutMs?: number): Promise<SandboxMessage> {
    const response = await this.send(text);
    if (response.status !== 200) {
      throw new Error(`webhook answered ${response.status} for "${text}"`);
    }
    return this.nextReply(`answer to "${text}"`, () => true, timeoutMs);
  }

  /** Skips every message that has arrived so far. */
  drain(): void {
    this.cursor = this.inbox().length;
  }
}

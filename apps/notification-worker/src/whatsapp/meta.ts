// WhatsApp Cloud API adapter (Meta Graph API, POST /{version}/{phone_number_id}/messages).
// Only unit-tested with a fake fetch; it is never exercised against the real network in tests.
// Error mapping: HTTP 429 or Cloud API rate-limit codes -> rate_limited; network errors, timeouts,
// and HTTP 5xx -> unavailable; any other 4xx -> rejected (permanent).
import type { MetaCloudConfig } from '../config.js';
import {
  WhatsAppSendError,
  type OutboundMessage,
  type SendResult,
  type WhatsAppAdapter,
} from './adapter.js';

/** Cloud API error codes that mean "slow down" (throughput, spam, and pair rate limits). */
const RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131048, 131056]);
const DEFAULT_TIMEOUT_MS = 10_000;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface MetaCloudAdapterOptions extends MetaCloudConfig {
  fetch?: FetchLike;
  timeoutMs?: number;
}

/** Request body of the Cloud API for `message`. */
export function metaRequestBody(message: OutboundMessage): Record<string, unknown> {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: message.to };
  const content = message.content;
  switch (content.kind) {
    case 'template':
      return {
        ...base,
        type: 'template',
        template: {
          name: content.name,
          language: { code: content.language },
          components:
            content.parameters.length === 0
              ? []
              : [
                  {
                    type: 'body',
                    parameters: content.parameters.map((text) => ({ type: 'text', text })),
                  },
                ],
        },
      };
    case 'text':
      return { ...base, type: 'text', text: { preview_url: false, body: content.body } };
    case 'buttons':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: content.body },
          action: {
            buttons: content.buttons.map((button) => ({
              type: 'reply',
              reply: { id: button.id, title: button.title },
            })),
          },
        },
      };
    case 'list':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: content.body },
          action: {
            button: content.button_text,
            sections: [
              {
                rows: content.rows.map((row) => ({
                  id: row.id,
                  title: row.title,
                  ...(row.description === undefined ? {} : { description: row.description }),
                })),
              },
            ],
          },
        },
      };
  }
}

interface CloudApiError {
  error?: { code?: unknown; message?: unknown };
}

export function classifyMetaError(status: number, body: unknown): WhatsAppSendError {
  const error = (body as CloudApiError | null)?.error;
  const code = typeof error?.code === 'number' ? error.code : null;
  const detail = typeof error?.message === 'string' ? error.message.slice(0, 200) : '';
  const message = `cloud api http ${status}${code === null ? '' : ` code ${code}`}${detail ? `: ${detail}` : ''}`;
  if (status === 429 || (code !== null && RATE_LIMIT_CODES.has(code))) {
    return new WhatsAppSendError('rate_limited', message, { status });
  }
  if (status >= 500) return new WhatsAppSendError('unavailable', message, { status });
  return new WhatsAppSendError('rejected', message, { status });
}

export class MetaCloudAdapter implements WhatsAppAdapter {
  readonly name = 'meta';
  private readonly options: MetaCloudAdapterOptions;
  private readonly fetch: FetchLike;

  constructor(options: MetaCloudAdapterOptions) {
    this.options = options;
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  get endpoint(): string {
    const { baseUrl, apiVersion, phoneNumberId } = this.options;
    return `${baseUrl}/${apiVersion}/${phoneNumberId}/messages`;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    let response: Response;
    try {
      response = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(metaRequestBody(message)),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      throw new WhatsAppSendError('unavailable', 'cloud api unreachable', { cause: error });
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Non-JSON body (e.g. a proxy error page); the status decides.
    }
    if (!response.ok) throw classifyMetaError(response.status, body);

    const id = (body as { messages?: { id?: unknown }[] } | null)?.messages?.[0]?.id;
    if (typeof id !== 'string' || id === '') {
      // Accepted without a wamid should not happen; treat as transient so it is retried.
      throw new WhatsAppSendError('unavailable', 'cloud api response without message id', {
        status: response.status,
      });
    }
    return { providerMessageId: id };
  }
}

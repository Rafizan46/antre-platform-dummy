import { describe, expect, it } from 'vitest';

import { WhatsAppSendError, type OutboundMessage } from './adapter.js';
import { MetaCloudAdapter, classifyMetaError, metaRequestBody, type FetchLike } from './meta.js';
import { SandboxMockAdapter, sandboxMessageId } from './sandbox.js';

const TEMPLATE: OutboundMessage = {
  to: '6281234567890',
  content: {
    kind: 'template',
    name: 'antre_ticket_called',
    language: 'id',
    parameters: ['Budi', 'panggilan', 'A-010', 'Loket 2', 'Klinik'],
    preview: 'Halo Budi, ...',
  },
};

const META = {
  accessToken: 'test-token',
  phoneNumberId: '1234567890',
  apiVersion: 'v23.0',
  baseUrl: 'https://graph.example.test',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('SandboxMockAdapter', () => {
  it('accepts messages with a deterministic wamid per idempotency key', async () => {
    const adapter = new SandboxMockAdapter();
    const first = await adapter.send(TEMPLATE, { idempotencyKey: 'evt-1' });
    const again = await adapter.send(TEMPLATE, { idempotencyKey: 'evt-1' });
    const other = await adapter.send(TEMPLATE, { idempotencyKey: 'evt-2' });
    expect(first.providerMessageId).toBe(sandboxMessageId('evt-1'));
    expect(first.providerMessageId).toMatch(/^wamid\.SANDBOX\.[0-9a-f]{32}$/);
    expect(again.providerMessageId).toBe(first.providerMessageId);
    expect(other.providerMessageId).not.toBe(first.providerMessageId);
    expect(adapter.sent).toHaveLength(3);
    expect(adapter.attempts).toBe(3);
  });

  it('fails as scripted: failNext once per send, failAlways until cleared', async () => {
    const adapter = new SandboxMockAdapter();
    adapter.failNext('rate_limited', 'unavailable');
    await expect(adapter.send(TEMPLATE, { idempotencyKey: 'a' })).rejects.toMatchObject({
      kind: 'rate_limited',
      status: 429,
      retryable: true,
    });
    await expect(adapter.send(TEMPLATE, { idempotencyKey: 'a' })).rejects.toMatchObject({
      kind: 'unavailable',
      status: 503,
    });
    await expect(adapter.send(TEMPLATE, { idempotencyKey: 'a' })).resolves.toBeDefined();

    adapter.failAlways('rejected');
    for (let index = 0; index < 3; index += 1) {
      await expect(adapter.send(TEMPLATE, { idempotencyKey: 'b' })).rejects.toMatchObject({
        kind: 'rejected',
        retryable: false,
      });
    }
    adapter.failAlways(null);
    await expect(adapter.send(TEMPLATE, { idempotencyKey: 'b' })).resolves.toBeDefined();
    expect(adapter.sent).toHaveLength(2);
    expect(adapter.attempts).toBe(7);
  });
});

describe('MetaCloudAdapter', () => {
  it('builds Cloud API bodies for templates, text, buttons, and lists', () => {
    expect(metaRequestBody(TEMPLATE)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '6281234567890',
      type: 'template',
      template: {
        name: 'antre_ticket_called',
        language: { code: 'id' },
        components: [
          {
            type: 'body',
            parameters:
              TEMPLATE.content.kind === 'template'
                ? TEMPLATE.content.parameters.map((text) => ({ type: 'text', text }))
                : [],
          },
        ],
      },
    });
    expect(metaRequestBody({ to: '628', content: { kind: 'text', body: 'Halo' } })).toMatchObject({
      type: 'text',
      text: { body: 'Halo', preview_url: false },
    });
    expect(
      metaRequestBody({
        to: '628',
        content: { kind: 'buttons', body: 'Pilih', buttons: [{ id: 'a', title: 'A' }] },
      }),
    ).toMatchObject({
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'Pilih' },
        action: { buttons: [{ type: 'reply', reply: { id: 'a', title: 'A' } }] },
      },
    });
    expect(
      metaRequestBody({
        to: '628',
        content: {
          kind: 'list',
          body: 'Pilih layanan',
          button_text: 'Layanan',
          rows: [
            { id: 's1', title: 'Poli Umum', description: '15 menit' },
            { id: 's2', title: 'Gigi' },
          ],
        },
      }),
    ).toMatchObject({
      type: 'interactive',
      interactive: {
        type: 'list',
        action: {
          button: 'Layanan',
          sections: [
            {
              rows: [
                { id: 's1', title: 'Poli Umum', description: '15 menit' },
                { id: 's2', title: 'Gigi' },
              ],
            },
          ],
        },
      },
    });
  });

  it('posts to the phone number endpoint with the bearer token and returns the wamid', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, { messaging_product: 'whatsapp', messages: [{ id: 'wamid.ABC' }] });
    };
    const adapter = new MetaCloudAdapter({ ...META, fetch });
    await expect(adapter.send(TEMPLATE)).resolves.toEqual({ providerMessageId: 'wamid.ABC' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://graph.example.test/v23.0/1234567890/messages');
    expect(calls[0]?.init.method).toBe('POST');
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      'Bearer test-token',
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(metaRequestBody(TEMPLATE));
  });

  it('maps HTTP and Cloud API errors to retryable or permanent failures', async () => {
    const respond = (status: number, body: unknown) =>
      new MetaCloudAdapter({ ...META, fetch: async () => jsonResponse(status, body) });
    await expect(respond(429, {}).send(TEMPLATE)).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(
      respond(400, { error: { code: 131056, message: 'pair rate limit' } }).send(TEMPLATE),
    ).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(respond(503, {}).send(TEMPLATE)).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(
      respond(400, { error: { code: 132001, message: 'template does not exist' } }).send(TEMPLATE),
    ).rejects.toMatchObject({ kind: 'rejected', retryable: false, status: 400 });
    await expect(respond(200, { messages: [] }).send(TEMPLATE)).rejects.toMatchObject({
      kind: 'unavailable',
    });

    const offline = new MetaCloudAdapter({
      ...META,
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const error = await offline.send(TEMPLATE).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WhatsAppSendError);
    expect(error).toMatchObject({ kind: 'unavailable', retryable: true });
    // The access token never ends up in an error message.
    expect(
      classifyMetaError(401, { error: { code: 190, message: 'bad token' } }).message,
    ).not.toContain('test-token');
  });
});

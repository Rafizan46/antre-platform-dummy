import { describe, expect, it } from 'vitest';

import { MAX_INBOUND_TEXT, extractWebhook } from './payload.js';
import { secretMatches, signPayload, verifySignature } from './signature.js';

const SECRET = 'app-secret-0123456789abcdef';

describe('X-Hub-Signature-256', () => {
  it('accepts the HMAC-SHA256 of the exact raw body', () => {
    const body = Buffer.from('{"object":"whatsapp_business_account"}');
    expect(verifySignature(body, signPayload(body, SECRET), SECRET)).toBe(true);
    // Only lowercase hex (the format Meta sends) is accepted, even for the same digest.
    expect(
      verifySignature(
        body,
        signPayload(body, SECRET).toUpperCase().replace('SHA256', 'sha256'),
        SECRET,
      ),
    ).toBe(false);
  });

  it('rejects another secret, another body, and malformed or repeated headers', () => {
    const body = Buffer.from('{"a":1}');
    const header = signPayload(body, SECRET);
    expect(verifySignature(body, signPayload(body, 'other-secret-000000'), SECRET)).toBe(false);
    expect(verifySignature(Buffer.from('{"a":2}'), header, SECRET)).toBe(false);
    expect(verifySignature(body, undefined, SECRET)).toBe(false);
    expect(verifySignature(body, [header, header], SECRET)).toBe(false);
    expect(verifySignature(body, header.replace('sha256=', 'sha1='), SECRET)).toBe(false);
    expect(verifySignature(body, `${header}00`, SECRET)).toBe(false);
  });

  it('compares the verify token in constant time regardless of length', () => {
    expect(secretMatches('verify-token', 'verify-token')).toBe(true);
    expect(secretMatches('verify', 'verify-token')).toBe(false);
  });
});

function notification(value: Record<string, unknown>, phoneNumberId = '111') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'x',
        changes: [
          { field: 'messages', value: { metadata: { phone_number_id: phoneNumberId }, ...value } },
        ],
      },
    ],
  };
}

describe('extractWebhook', () => {
  it('reads text, button replies, list replies, and template buttons', () => {
    const content = extractWebhook(
      notification({
        contacts: [{ wa_id: '6281234567890', profile: { name: '  Budi  ' } }],
        messages: [
          {
            from: '6281234567890',
            id: 'w1',
            timestamp: '1',
            type: 'text',
            text: { body: 'ANTRE a b' },
          },
          {
            from: '6281234567890',
            id: 'w2',
            type: 'interactive',
            interactive: {
              type: 'button_reply',
              button_reply: { id: 'menu:walkin', title: 'Ambil Antrean' },
            },
          },
          {
            from: '6281234567890',
            id: 'w3',
            type: 'interactive',
            interactive: {
              type: 'list_reply',
              list_reply: { id: 'svc:1', title: 'Umum', description: 'x' },
            },
          },
          {
            from: '6281234567890',
            id: 'w4',
            type: 'button',
            button: { payload: 'cmd:status', text: 'Cek' },
          },
          { from: '6281234567890', id: 'w5', type: 'image', image: { id: 'media' } },
        ],
      }),
      { phoneNumberId: null },
    );
    expect(content?.messages).toEqual([
      {
        wamid: 'w1',
        from: '6281234567890',
        profileName: 'Budi',
        type: 'text',
        text: 'ANTRE a b',
        replyId: null,
      },
      {
        wamid: 'w2',
        from: '6281234567890',
        profileName: 'Budi',
        type: 'interactive',
        text: 'Ambil Antrean',
        replyId: 'menu:walkin',
      },
      {
        wamid: 'w3',
        from: '6281234567890',
        profileName: 'Budi',
        type: 'interactive',
        text: 'Umum',
        replyId: 'svc:1',
      },
      {
        wamid: 'w4',
        from: '6281234567890',
        profileName: 'Budi',
        type: 'button',
        text: 'Cek',
        replyId: 'cmd:status',
      },
      {
        wamid: 'w5',
        from: '6281234567890',
        profileName: 'Budi',
        type: 'image',
        text: null,
        replyId: null,
      },
    ]);
    expect(content?.ignored).toBe(0);
  });

  it('skips malformed entries without dropping the others', () => {
    const content = extractWebhook(
      notification({
        messages: [
          { from: '+62812', id: 'bad-sender', type: 'text', text: { body: 'x' } },
          { id: 'no-sender', type: 'text' },
          { from: '6281234567890', id: 'ok', type: 'text', text: { body: 'halo' } },
        ],
        statuses: [
          { id: 's1', status: 'failed', timestamp: '1792378800', recipient_id: '6281234567890' },
          { id: 's2', status: 'sent' },
        ],
      }),
      { phoneNumberId: null },
    );
    expect(content?.messages.map((message) => message.wamid)).toEqual(['ok']);
    expect(content?.messages[0]?.profileName).toBeNull();
    expect(content?.statuses.map((status) => status.status)).toEqual(['FAILED']);
    expect(content?.ignored).toBe(3);
  });

  it('caps the text length and treats blank text as no text', () => {
    const content = extractWebhook(
      notification({
        messages: [
          { from: '6281234567890', id: 'long', type: 'text', text: { body: 'x'.repeat(5000) } },
          { from: '6281234567890', id: 'blank', type: 'text', text: { body: '   ' } },
        ],
      }),
      { phoneNumberId: null },
    );
    expect(content?.messages[0]?.text).toHaveLength(MAX_INBOUND_TEXT);
    expect(content?.messages[1]?.text).toBeNull();
  });

  it('returns null for other objects and filters by phone number id', () => {
    expect(extractWebhook({ object: 'page', entry: [] }, { phoneNumberId: null })).toBeNull();
    expect(extractWebhook('x', { phoneNumberId: null })).toBeNull();
    const other = extractWebhook(
      notification(
        { messages: [{ from: '6281234567890', id: 'w', type: 'text', text: { body: 'x' } }] },
        '222',
      ),
      { phoneNumberId: '111' },
    );
    expect(other?.messages).toEqual([]);
    expect(other?.ignored).toBe(1);
  });
});

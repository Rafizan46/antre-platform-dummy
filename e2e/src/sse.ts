// Minimal Server-Sent Events client on top of fetch streaming (no EventSource dependency).
import { eventually } from './stack.js';

export interface SseMessage {
  event: string;
  id?: string;
  data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface SseConnection {
  status: number;
  /** Parsed JSON body of a non-200 response. */
  body: unknown;
  messages: SseMessage[];
  /** Raw text received so far (to assert that nothing leaked into the stream). */
  raw(): string;
  waitFor(predicate: (message: SseMessage) => boolean, description: string): Promise<SseMessage>;
  close(): void;
}

function parseBlock(block: string): SseMessage | null {
  let event = 'message';
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  return { event, ...(id === undefined ? {} : { id }), data: JSON.parse(data.join('\n')) };
}

/** Opens the location stream with a staff or kiosk token (query parameter, like a browser). */
export async function openStream(
  realtimeUrl: string,
  locationId: string,
  token: string,
): Promise<SseConnection> {
  const controller = new AbortController();
  const url = new URL(`${realtimeUrl}/api/v1/realtime/locations/${locationId}/stream`);
  url.searchParams.set('access_token', token);
  const response = await fetch(url, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });
  const messages: SseMessage[] = [];
  let received = '';

  if (response.status !== 200) {
    const body: unknown = await response.json().catch(() => null);
    return {
      status: response.status,
      body,
      messages,
      raw: () => received,
      waitFor: () => Promise.reject(new Error(`stream refused with ${response.status}`)),
      close: () => controller.abort(),
    };
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        received += chunk;
        buffer += chunk.replace(/\r\n/g, '\n');
        let index: number;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const parsed = parseBlock(buffer.slice(0, index));
          buffer = buffer.slice(index + 2);
          if (parsed !== null) messages.push(parsed);
        }
      }
    } catch {
      // Aborted by close() or reset by the server.
    }
  })();

  return {
    status: 200,
    body: null,
    messages,
    raw: () => received,
    waitFor: (predicate, description) =>
      eventually(`SSE event: ${description}`, () => messages.find(predicate), {
        timeoutMs: 10_000,
      }),
    close: () => controller.abort(),
  };
}

/** Predicate for a realtime update of the given type (and ticket number, when given). */
export function update(type: string, ticketNumber?: string): (message: SseMessage) => boolean {
  return (message) =>
    message.event === 'update' &&
    message.data?.type === type &&
    (ticketNumber === undefined || message.data?.ticket_number === ticketNumber);
}

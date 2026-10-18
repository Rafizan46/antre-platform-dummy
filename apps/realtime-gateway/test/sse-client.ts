// Minimal SSE client for the tests (fetch + text/event-stream parser), like EventSource but with
// access to the HTTP status and explicit Last-Event-ID.
export interface SseMessage {
  event: string;
  id?: string;
  data: unknown;
}

export interface SseConnection {
  status: number;
  /** Body of a non-200 response (JSON). */
  body: unknown;
  messages: SseMessage[];
  comments: string[];
  /** Resolves when the server ends the stream. */
  ended: Promise<void>;
  isEnded(): boolean;
  waitFor(predicate: (message: SseMessage) => boolean, timeoutMs?: number): Promise<SseMessage>;
  close(): void;
}

export function parseSseBlock(block: string): { message?: SseMessage; comment?: string } {
  let event = 'message';
  let id: string | undefined;
  const data: string[] = [];
  let comment: string | undefined;
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) {
      comment = line.slice(1).trim();
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return comment === undefined ? {} : { comment };
  return {
    message: { event, ...(id === undefined ? {} : { id }), data: JSON.parse(data.join('\n')) },
  };
}

export async function openSse(
  url: string,
  options: { token?: string; lastEventId?: string; header?: boolean } = {},
): Promise<SseConnection> {
  const controller = new AbortController();
  const target = new URL(url);
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (options.token !== undefined) {
    if (options.header === true) headers.authorization = `Bearer ${options.token}`;
    else target.searchParams.set('access_token', options.token);
  }
  if (options.lastEventId !== undefined) headers['last-event-id'] = options.lastEventId;
  const response = await fetch(target, { headers, signal: controller.signal });

  const messages: SseMessage[] = [];
  const comments: string[] = [];
  const waiters: (() => void)[] = [];
  let ended = false;
  const notify = () => waiters.splice(0).forEach((wake) => wake());

  if (response.status !== 200) {
    const body: unknown = await response.json();
    return {
      status: response.status,
      body,
      messages,
      comments,
      ended: Promise.resolve(),
      isEnded: () => true,
      waitFor: () => Promise.reject(new Error(`stream refused with ${response.status}`)),
      close: () => controller.abort(),
    };
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const endedPromise = (async () => {
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const parsed = parseSseBlock(buffer.slice(0, index));
          buffer = buffer.slice(index + 2);
          if (parsed.message !== undefined) messages.push(parsed.message);
          if (parsed.comment !== undefined) comments.push(parsed.comment);
        }
        notify();
      }
    } catch {
      // Aborted or reset.
    } finally {
      ended = true;
      notify();
    }
  })();

  return {
    status: 200,
    body: null,
    messages,
    comments,
    ended: endedPromise,
    isEnded: () => ended,
    waitFor(predicate, timeoutMs = 5_000) {
      return new Promise((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error('timed out waiting for SSE event')),
          timeoutMs,
        );
        const check = () => {
          const found = messages.find(predicate);
          if (found !== undefined) {
            clearTimeout(deadline);
            resolve(found);
          } else if (ended) {
            clearTimeout(deadline);
            reject(new Error('stream ended before the SSE event'));
          } else {
            waiters.push(check);
          }
        };
        check();
      });
    },
    close: () => controller.abort(),
  };
}

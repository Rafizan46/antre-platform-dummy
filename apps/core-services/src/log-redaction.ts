// Request log redaction (S09): /internal/v1 endpoints of the WhatsApp Channel Service take the
// customer's phone number in the query string (spec section 8), and Fastify logs the request URL.
// The request serializer masks phone numbers in the query so access logs never hold a full number.
import type { FastifyRequest } from 'fastify';

/** Query parameters that carry a phone number. */
const PHONE_PARAMETERS = new Set(['customer_phone']);

/** 6281234567890 -> 628******7890 (same masking as the WA Channel Service and the worker). */
export function maskPhone(phone: string): string {
  if (phone.length <= 7) return '*'.repeat(phone.length);
  return `${phone.slice(0, 3)}${'*'.repeat(phone.length - 7)}${phone.slice(-4)}`;
}

/** `url` with the values of phone parameters masked; the path and other parameters unchanged. */
export function redactUrl(url: string): string {
  const index = url.indexOf('?');
  if (index < 0) return url;
  const query = url
    .slice(index + 1)
    .split('&')
    .map((pair) => {
      const separator = pair.indexOf('=');
      if (separator < 0) return pair;
      const name = pair.slice(0, separator);
      let decodedName: string;
      try {
        decodedName = decodeURIComponent(name);
      } catch {
        decodedName = name;
      }
      if (!PHONE_PARAMETERS.has(decodedName)) return pair;
      let value: string;
      try {
        value = decodeURIComponent(pair.slice(separator + 1).replace(/\+/g, ' '));
      } catch {
        value = pair.slice(separator + 1);
      }
      return `${name}=${encodeURIComponent(maskPhone(value))}`;
    })
    .join('&');
  return `${url.slice(0, index)}?${query}`;
}

/** Fastify's default request serializer, with the URL redacted. */
export function serializeRequest(request: FastifyRequest) {
  return {
    method: request.method,
    url: redactUrl(request.url),
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

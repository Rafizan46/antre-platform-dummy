/* eslint-disable @typescript-eslint/no-explicit-any */
// Small HTTP client for the public API (through fetch), plus the signed callbacks of the payment
// provider. Everything here talks to the real services over HTTP, like a browser or Meta would.
import { createHmac } from 'node:crypto';

import { stack } from './stack.js';

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

export interface ApiOptions {
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Base URL; defaults to the core services. */
  base?: string;
}

export async function api<T = any>(
  method: string,
  path: string,
  options: ApiOptions = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  let payload: string | undefined;
  if (options.body !== undefined) {
    payload = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    headers['content-type'] ??= 'application/json';
  }
  const response = await fetch(`${options.base ?? stack().coreUrl}${path}`, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON (plain text such as the webhook challenge).
  }
  return { status: response.status, body: body as T };
}

/** `sha256=<hex>` HMAC of the exact body bytes, as Meta and the payment provider sign. */
export function signature(rawBody: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

export interface PaymentCallbackBody {
  payment_ref: string;
  tenant_id: string;
  target_id: string;
  amount: number;
  status: 'PAID' | 'FAILED';
}

/** Posts a payment-provider callback signed with PAYMENT_CALLBACK_SECRET (spec section 7.4). */
export function paymentCallback(
  path: '/api/v1/payments/qris/callback' | '/api/v1/billing/payments/callback',
  body: PaymentCallbackBody,
  secret: string = stack().secrets.paymentCallback,
): Promise<ApiResponse> {
  const raw = JSON.stringify(body);
  return api('POST', path, { body: raw, headers: { 'x-antre-signature': signature(raw, secret) } });
}

/** Internal service API (/internal/v1), as the WA Channel calls it with the service token. */
export function internal<T = any>(
  method: string,
  path: string,
  tenantId: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  return api<T>(method, `/internal/v1${path}`, {
    token: stack().secrets.serviceToken,
    headers: { 'x-antre-tenant-id': tenantId },
    body,
  });
}

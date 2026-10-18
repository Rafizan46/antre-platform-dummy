// Thin typed HTTP client: bearer token, JSON, error mapping, and optional zod validation of the
// response. A 401 on an authenticated request calls onUnauthorized (session expired).
import type { ErrorCode } from '@antre/shared-types';
import type { ZodType } from 'zod';

import { ApiError, badResponse, networkError } from './errors';

export interface ApiClientOptions {
  baseUrl?: string;
  getToken: () => string | null;
  onUnauthorized: () => void;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions<T> {
  query?: Record<string, string | undefined>;
  body?: unknown;
  schema?: ZodType<T>;
}

export interface ApiClient {
  get<T>(path: string, options?: RequestOptions<T>): Promise<T>;
  post<T>(path: string, options?: RequestOptions<T>): Promise<T>;
  patch<T>(path: string, options?: RequestOptions<T>): Promise<T>;
  put<T>(path: string, options?: RequestOptions<T>): Promise<T>;
  delete(path: string): Promise<void>;
}

export function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.set(key, value);
  }
  const search = params.toString();
  return `${baseUrl.replace(/\/+$/, '')}${path}${search === '' ? '' : `?${search}`}`;
}

async function readError(response: Response): Promise<ApiError> {
  try {
    const json = (await response.json()) as {
      error?: { code?: ErrorCode; message?: string; details?: unknown };
    };
    const error = json.error;
    if (error?.code !== undefined) {
      return new ApiError(response.status, error.code, error.message ?? '', error.details);
    }
  } catch {
    // not a JSON error body
  }
  return new ApiError(
    response.status,
    response.status === 401 ? 'UNAUTHORIZED' : 'INTERNAL_ERROR',
    '',
  );
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const baseUrl = options.baseUrl ?? '';

  async function send(method: string, path: string, request: RequestOptions<unknown> = {}) {
    const token = options.getToken();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    if (request.body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try {
      response = await doFetch(buildUrl(baseUrl, path, request.query), {
        method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
    } catch {
      throw networkError();
    }
    if (!response.ok) {
      const error = await readError(response);
      if (response.status === 401 && token !== null && error.code === 'UNAUTHORIZED') {
        options.onUnauthorized();
      }
      throw error;
    }
    return response;
  }

  async function json<T>(method: string, path: string, request?: RequestOptions<T>): Promise<T> {
    const response = await send(method, path, request);
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw badResponse(response.status);
    }
    if (request?.schema === undefined) return data as T;
    const parsed = request.schema.safeParse(data);
    if (!parsed.success) throw badResponse(response.status);
    return parsed.data;
  }

  return {
    get: (path, request) => json('GET', path, request),
    post: (path, request) => json('POST', path, request),
    patch: (path, request) => json('PATCH', path, request),
    put: (path, request) => json('PUT', path, request),
    delete: async (path) => {
      await send('DELETE', path);
    },
  };
}

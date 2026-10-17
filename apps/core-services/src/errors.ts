// Application errors and the central Fastify error handling (body format ApiErrorBody, spec section 8).
import {
  ERROR_HTTP_STATUS,
  uuidSchema,
  type ApiErrorBody,
  type ErrorCode,
} from '@antre/shared-types';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;
  readonly headers?: Record<string, string>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: unknown; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = ERROR_HTTP_STATUS[code];
    this.details = options.details;
    this.headers = options.headers;
  }
}

/** Parses `value` with `schema`; any issue becomes a 400 VALIDATION_ERROR listing path and message. */
export function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 'Data yang dikirim tidak valid.', {
      details: {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
  }
  return result.data;
}

/** A path id that is not a uuid cannot exist: 404 with `message`. */
export function parseIdOr404(value: string, message: string): string {
  if (!uuidSchema.safeParse(value).success) throw new AppError('NOT_FOUND', message);
  return value;
}

function errorBody(code: ErrorCode, message: string, details?: unknown): ApiErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      if (error.headers) {
        void reply.headers(error.headers);
      }
      return reply
        .status(error.statusCode)
        .send(errorBody(error.code, error.message, error.details));
    }

    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply
        .status(400)
        .send(errorBody('VALIDATION_ERROR', 'Permintaan tidak dapat diproses.'));
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send(errorBody('INTERNAL_ERROR', 'Terjadi kesalahan pada server.'));
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send(errorBody('NOT_FOUND', 'Sumber daya tidak ditemukan.')),
  );
}

/** Name of the violated constraint when `error` is a PostgreSQL unique violation (23505), else null. */
export function uniqueViolationConstraint(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === '23505' && typeof constraint === 'string' ? constraint : null;
}

/** True when `error` is a PostgreSQL foreign key violation (23503). */
export function foreignKeyViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23503'
  );
}

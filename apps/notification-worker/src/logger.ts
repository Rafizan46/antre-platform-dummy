// Minimal structured logger (one JSON object per line, pino-like fields) so the worker does not
// need a logging dependency. Errors under `err` are serialised with name, message, and code.
export interface Logger {
  debug(object: object, message: string): void;
  info(object: object, message: string): void;
  warn(object: object, message: string): void;
  error(object: object, message: string): void;
}

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, silent: 100 } as const;
export type LogLevel = keyof typeof LEVELS;

export function isLogLevel(value: string): value is LogLevel {
  return Object.hasOwn(LEVELS, value);
}

function serialiseError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const { code } = error as { code?: unknown };
  return {
    type: error.name,
    message: error.message,
    ...(code === undefined ? {} : { code }),
    stack: error.stack,
  };
}

export function createLogger(
  options: { level?: LogLevel; name?: string; write?: (line: string) => void } = {},
): Logger {
  const threshold = LEVELS[options.level ?? 'info'];
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const emit =
    (level: Exclude<LogLevel, 'silent'>) =>
    (object: object, message: string): void => {
      if (LEVELS[level] < threshold) return;
      const fields: Record<string, unknown> = { ...object };
      if ('err' in fields) fields.err = serialiseError(fields.err);
      write(
        JSON.stringify({
          level: LEVELS[level],
          time: Date.now(),
          name: options.name ?? 'notification-worker',
          ...fields,
          msg: message,
        }),
      );
    };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

export const silentLogger: Logger = createLogger({ level: 'silent' });

/** 6281234567890 -> 628******7890: recipients in logs are masked (spec section 7.1). */
export function maskPhone(phone: string): string {
  if (phone.length <= 7) return '*'.repeat(phone.length);
  return `${phone.slice(0, 3)}${'*'.repeat(phone.length - 7)}${phone.slice(-4)}`;
}

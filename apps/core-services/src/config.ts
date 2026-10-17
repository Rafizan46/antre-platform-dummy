// Service configuration read from the environment. Error messages never contain secret values.

export interface CoreConfig {
  databaseUrl: string;
  jwtSecret: string;
}

const MIN_SECRET_LENGTH = 32;

export function loadConfig(env: NodeJS.ProcessEnv): CoreConfig {
  const databaseUrl = env.DATABASE_APP_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_APP_URL is not set');
  }

  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error('JWT_SECRET is not set');
  }
  if (jwtSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (env.NODE_ENV === 'production' && jwtSecret.startsWith('dev-only')) {
    throw new Error('JWT_SECRET must not be a dev-only placeholder in production');
  }

  return { databaseUrl, jwtSecret };
}

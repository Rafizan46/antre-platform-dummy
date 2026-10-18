// Session storage. The token lives in memory and in sessionStorage (per tab, gone when the tab
// closes) and never in localStorage: an XSS can still read it, but it does not outlive the tab.
import type { UserRole } from '@antre/shared-types';

import type { LoginResult } from '../api/schemas';

export const SESSION_KEY = 'antre.staff.session';

export interface Session {
  token: string;
  /** Epoch ms after which the token is no longer valid. */
  expiresAt: number;
  user: { id: string; email: string; role: UserRole; tenantId: string | null };
}

export function sessionFromLogin(result: LoginResult, now: number): Session {
  return {
    token: result.access_token,
    expiresAt: now + result.expires_in * 1000,
    user: {
      id: result.user.id,
      email: result.user.email,
      role: result.user.role,
      tenantId: result.user.tenant_id,
    },
  };
}

export function isExpired(session: Session, now: number): boolean {
  return session.expiresAt <= now;
}

export function loadSession(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  now: number,
): Session | null {
  const raw = storage.getItem(SESSION_KEY);
  if (raw === null) return null;
  try {
    const session = JSON.parse(raw) as Session;
    if (
      typeof session.token === 'string' &&
      typeof session.expiresAt === 'number' &&
      typeof session.user?.role === 'string' &&
      !isExpired(session, now)
    ) {
      return session;
    }
  } catch {
    // corrupt value
  }
  storage.removeItem(SESSION_KEY);
  return null;
}

export function saveSession(storage: Pick<Storage, 'setItem'>, session: Session): void {
  storage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(storage: Pick<Storage, 'removeItem'>): void {
  storage.removeItem(SESSION_KEY);
}

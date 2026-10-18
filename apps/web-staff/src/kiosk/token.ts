// The KIOSK_DISPLAY token is installed once by opening kiosk.html?token=<token>; it is kept in
// localStorage and removed from the address bar. The location id comes from the token payload
// (decoded, not verified: the gateway verifies it).
export const TOKEN_STORAGE_KEY = 'antre.kiosk.token';

export interface KioskIdentity {
  token: string;
  locationId: string;
  expiresAt: number | null;
}

export function decodeKioskToken(token: string): KioskIdentity | null {
  const payload = token.split('.')[1];
  if (payload === undefined) return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))) as {
      role?: unknown;
      location_id?: unknown;
      exp?: unknown;
    };
    if (json.role !== 'KIOSK_DISPLAY' || typeof json.location_id !== 'string') return null;
    return {
      token,
      locationId: json.location_id,
      expiresAt: typeof json.exp === 'number' ? json.exp * 1000 : null,
    };
  } catch {
    return null;
  }
}

export function loadKioskIdentity(
  location: Pick<Location, 'search' | 'pathname' | 'hash'>,
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  replaceUrl: (url: string) => void,
): KioskIdentity | null {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get('token');
  if (fromUrl !== null) {
    params.delete('token');
    const query = params.toString();
    replaceUrl(`${location.pathname}${query === '' ? '' : `?${query}`}${location.hash}`);
    const identity = decodeKioskToken(fromUrl);
    if (identity !== null) {
      storage.setItem(TOKEN_STORAGE_KEY, fromUrl);
      return identity;
    }
  }
  const stored = storage.getItem(TOKEN_STORAGE_KEY);
  return stored === null ? null : decodeKioskToken(stored);
}

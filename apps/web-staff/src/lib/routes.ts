// Tiny hash router (no dependency) and the role guard of each route.
import type { UserRole } from '@antre/shared-types';
import { useCallback, useEffect, useState } from 'react';

export type Route =
  | { name: 'login' }
  | { name: 'register' }
  | { name: 'dashboard' }
  | { name: 'settings'; tab: SettingsTab }
  | { name: 'not-found' };

export const SETTINGS_TABS = [
  'layanan',
  'resource',
  'jam',
  'mode',
  'staf',
  'kiosk',
  'langganan',
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export const SETTINGS_TAB_LABELS: Record<SettingsTab, string> = {
  layanan: 'Layanan',
  resource: 'Resource',
  jam: 'Jam operasional',
  mode: 'Mode & branding',
  staf: 'Staf',
  kiosk: 'Kiosk TV',
  langganan: 'Langganan',
};

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '').split('?')[0] ?? '';
  const parts = path.split('/').filter((part) => part !== '');
  const [first, second] = parts;
  if (first === undefined) return { name: 'dashboard' };
  if (parts.length === 1 && first === 'login') return { name: 'login' };
  if (parts.length === 1 && first === 'daftar') return { name: 'register' };
  if (first === 'pengaturan' && parts.length <= 2) {
    if (second === undefined) return { name: 'settings', tab: 'layanan' };
    const tab = SETTINGS_TABS.find((candidate) => candidate === second);
    if (tab !== undefined) return { name: 'settings', tab };
  }
  return { name: 'not-found' };
}

export function hashFor(route: Route): string {
  switch (route.name) {
    case 'login':
      return '#/login';
    case 'register':
      return '#/daftar';
    case 'settings':
      return `#/pengaturan/${route.tab}`;
    default:
      return '#/';
  }
}

/** Public routes need no session; settings are for the OWNER only. */
export function isPublicRoute(route: Route): boolean {
  return route.name === 'login' || route.name === 'register' || route.name === 'not-found';
}

export function isRouteAllowed(route: Route, role: UserRole): boolean {
  if (route.name === 'settings') return role === 'OWNER';
  if (route.name === 'dashboard') return role !== 'SUPER_ADMIN';
  return true;
}

/** Where to send the user for a route: null = render it. */
export function resolveRoute(route: Route, role: UserRole | null): Route | null {
  if (role === null) return isPublicRoute(route) ? null : { name: 'login' };
  if (route.name === 'login' || route.name === 'register') return { name: 'dashboard' };
  if (!isRouteAllowed(route, role)) return { name: 'dashboard' };
  return null;
}

export function useHashRoute(): [Route, (route: Route) => void] {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const navigate = useCallback((route: Route) => {
    window.location.hash = hashFor(route);
  }, []);
  return [parseHash(hash), navigate];
}

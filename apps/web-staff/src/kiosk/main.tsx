// Entry of the Kiosk TV page (kiosk.html), separate from the dashboard bundle (NFR-ACCS-02).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { KioskApp } from './KioskApp';
import { loadKioskIdentity } from './token';
import './kiosk.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

const identity = loadKioskIdentity(window.location, window.localStorage, (url) =>
  window.history.replaceState(null, '', url),
);
// Same origin by default (the API gateway routes /api/v1/realtime); VITE_REALTIME_URL overrides.
const baseUrl = (import.meta.env.VITE_REALTIME_URL as string | undefined) ?? '';

createRoot(rootElement).render(
  <StrictMode>
    <KioskApp identity={identity} baseUrl={baseUrl} />
  </StrictMode>,
);

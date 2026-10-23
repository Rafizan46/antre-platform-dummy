import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-700.css';
import './styles.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element #root not found');
}

// Same origin by default (the API gateway or the dev proxy); VITE_API_URL points to another host.
const baseUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

createRoot(rootElement).render(
  <StrictMode>
    <App baseUrl={baseUrl} />
  </StrictMode>,
);

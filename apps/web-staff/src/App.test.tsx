// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from './App';

describe('App', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.location.hash = '';
  });
  afterEach(cleanup);

  it('sends an anonymous visitor to the login page', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Masuk ke Antre' })).toBeTruthy();
    expect(window.location.hash).toBe('#/login');
  });
});

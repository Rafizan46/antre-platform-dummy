// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import type { Resource, Ticket } from './api/schemas';
import { ServiceQueue } from './dashboard/TicketList';
import type { EventSourceLike } from './kiosk/connection';
import { useRealtimeFeed } from './lib/hooks';
import { EMPTY_SERVICE, ServiceForm } from './settings/ServicesTab';

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.location.hash = '';
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('login', () => {
  it('logs in, keeps the session in sessionStorage only, and shows the dashboard', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/auth/login')) {
        return json(200, {
          access_token: 'jwt',
          token_type: 'Bearer',
          expires_in: 3600,
          user: { id: 'u', email: 'o@x.id', role: 'OWNER', tenant_id: 't' },
        });
      }
      return json(200, { locations: [] });
    });
    render(<App fetchImpl={fetchImpl as unknown as typeof fetch} />);
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'o@x.id' } });
    fireEvent.change(screen.getByLabelText('Kata sandi'), { target: { value: 'rahasia123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Masuk' }));
    expect(await screen.findByText('Belum ada lokasi aktif.')).toBeTruthy();
    expect(window.sessionStorage.getItem('antre.staff.session')).toContain('jwt');
    expect(window.localStorage.length).toBe(0);
    expect(screen.getByRole('link', { name: 'Pengaturan' })).toBeTruthy();
  });

  it('shows the Indonesian message for wrong credentials', async () => {
    const fetchImpl = vi.fn(async () =>
      json(401, { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid' } }),
    );
    render(<App fetchImpl={fetchImpl as unknown as typeof fetch} />);
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'o@x.id' } });
    fireEvent.change(screen.getByLabelText('Kata sandi'), { target: { value: 'salah' } });
    fireEvent.click(screen.getByRole('button', { name: 'Masuk' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Email atau kata sandi salah.');
  });
});

const resources: Resource[] = [
  {
    id: 'r1',
    location_id: 'l',
    name: 'Loket 1',
    resource_type: null,
    is_active: true,
    service_ids: ['s1'],
  },
];

function ticket(id: string, status: Ticket['status']): Ticket {
  return {
    id,
    location_id: 'l',
    service_id: 's1',
    service_name: 'Umum',
    resource_id: null,
    resource_name: null,
    ticket_number: `A-00${id}`,
    channel: 'STAFF',
    customer_name: 'Budi',
    status,
    recall_count: 0,
    people_ahead: null,
    called_at: null,
    serving_at: null,
    completed_at: null,
    created_at: 'x',
  };
}

describe('ServiceQueue', () => {
  const tickets = [ticket('1', 'CALLED'), ticket('2', 'WAITING')];
  const renderQueue = (role: 'STAFF_CALLER' | 'STAFF_CASHIER') => {
    const onAction = vi.fn();
    const onCallNext = vi.fn();
    render(
      <ServiceQueue
        serviceId="s1"
        serviceName="Umum"
        tickets={tickets}
        resources={resources}
        role={role}
        busy={false}
        onCallNext={onCallNext}
        onAction={onAction}
      />,
    );
    return { onAction, onCallNext };
  };

  it('shows only legal actions for the status and calls the handlers', () => {
    const { onAction, onCallNext } = renderQueue('STAFF_CALLER');
    expect(screen.queryByRole('button', { name: /Selesai A-001/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Layani A-001' }));
    expect(onAction).toHaveBeenCalledWith(tickets[0], 'SERVE');
    fireEvent.click(screen.getByRole('button', { name: 'Panggil berikutnya' }));
    expect(onCallNext).toHaveBeenCalledWith('s1', 'r1');
  });

  it('hides call buttons for a cashier', () => {
    renderQueue('STAFF_CASHIER');
    expect(screen.queryByRole('button', { name: 'Panggil berikutnya' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Layani/ })).toBeNull();
  });
});

describe('ServiceForm', () => {
  it('rejects an invalid prefix and submits a valid service', async () => {
    const onSubmit = vi.fn(async () => true);
    render(
      <ServiceForm initial={EMPTY_SERVICE} busy={false} submitLabel="Simpan" onSubmit={onSubmit} />,
    );
    fireEvent.change(screen.getByLabelText('Nama layanan'), { target: { value: 'Cukur' } });
    fireEvent.change(screen.getByLabelText(/Prefiks tiket/), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Prefiks tiket/), { target: { value: 'c' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Cukur',
        ticket_prefix: 'C',
        requires_dp: false,
        dp_amount: null,
      }),
    );
  });
});

describe('useRealtimeFeed', () => {
  it('connects with the token, relays updates, and closes on unmount', () => {
    const listeners = new Map<string, (e: MessageEvent<string>) => void>();
    const source = {
      readyState: 0,
      onopen: null,
      onerror: null,
      close: vi.fn(),
      addEventListener: (type: string, cb: (e: MessageEvent<string>) => void) =>
        listeners.set(type, cb),
    } as unknown as EventSourceLike;
    const createEventSource = vi.fn((url: string) => (url ? source : source));
    const onUpdate = vi.fn();

    function Probe() {
      const feed = useRealtimeFeed(
        { baseUrl: '', locationId: 'loc', token: 'tok', createEventSource },
        onUpdate,
      );
      return <span>{feed.status}</span>;
    }
    const { unmount } = render(<Probe />);
    expect(createEventSource.mock.calls[0]?.[0]).toContain(
      '/api/v1/realtime/locations/loc/stream?access_token=tok',
    );
    listeners.get('update')?.({
      data: JSON.stringify({ type: 'queue.ticket.called' }),
      lastEventId: '1',
    } as MessageEvent<string>);
    expect(onUpdate).toHaveBeenCalledWith({ type: 'queue.ticket.called' });
    unmount();
    expect(source.close).toHaveBeenCalled();
  });
});

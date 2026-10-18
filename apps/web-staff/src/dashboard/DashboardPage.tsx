import type { RealtimeUpdate } from '@antre/messaging/realtime';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError, describeError } from '../api/errors';
import type { Booking, Ticket } from '../api/schemas';
import { useAuth } from '../auth/AuthContext';
import { Empty, ErrorNotice, Loading, SelectField } from '../components/ui';
import type { ConnectionStatus } from '../kiosk/connection';
import { canActOnBookings, canCreateTicket, type StaffTicketAction } from '../lib/actions';
import { useRealtimeFeed, useResource } from '../lib/hooks';
import { BookingList } from './BookingList';
import { applyUpdate, computeMetrics, groupByService, localDate } from './liveState';
import { ManualTicketForm, type ManualTicketValues } from './ManualTicketForm';
import { ServiceQueue } from './TicketList';

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: 'Menghubungkan...',
  open: 'Langsung (live)',
  reconnecting: 'Menyambung ulang...',
  stopped: 'Terputus',
};
const REFRESH_DEBOUNCE_MS = 400;
const REALTIME_URL = (import.meta.env.VITE_REALTIME_URL as string | undefined) ?? '';

export function DashboardPage() {
  const { api, session } = useAuth();
  const role = session!.user.role;
  const token = session!.token;

  const locations = useResource('locations', () => api.locations());
  const [chosenId, setChosenId] = useState('');
  const activeLocations = useMemo(
    () => (locations.data ?? []).filter((l) => l.is_active),
    [locations.data],
  );
  const location = activeLocations.find((l) => l.id === chosenId) ?? activeLocations[0];
  const locationId = location?.id ?? null;
  const date = location ? localDate(new Date(), location.timezone) : '';

  const tickets = useResource(locationId, () => api.tickets(locationId!));
  const resources = useResource(locationId, () => api.resources(locationId!));
  const services = useResource('services', () => api.services());
  const showBookings = locationId !== null;
  const bookings = useResource(showBookings ? `${locationId}|${date}` : null, () =>
    api.bookings(locationId!, date),
  );

  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Realtime: patch the list at once, then refetch (debounced) for times and new tickets.
  const ticketsRef = useRef<Ticket[]>([]);
  ticketsRef.current = tickets.data ?? [];
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadTickets = tickets.reload;
  const reloadBookings = bookings.reload;
  const setTickets = tickets.setData;
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      reloadTickets();
      reloadBookings();
    }, REFRESH_DEBOUNCE_MS);
  }, [reloadTickets, reloadBookings]);
  useEffect(
    () => () => {
      if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
    },
    [],
  );
  const onUpdate = useCallback(
    (update: RealtimeUpdate) => {
      const result = applyUpdate(ticketsRef.current, update);
      if (result.tickets !== ticketsRef.current) setTickets(result.tickets);
      if (result.needsRefresh) scheduleRefresh();
    },
    [setTickets, scheduleRefresh],
  );
  const feed = useRealtimeFeed(
    { baseUrl: REALTIME_URL, locationId, token },
    onUpdate,
    scheduleRefresh,
  );

  async function run(work: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setActionError(null);
    try {
      await work();
      return true;
    } catch (error) {
      setActionError(describeError(error));
      return false;
    } finally {
      setBusy(false);
      reloadTickets();
      reloadBookings();
    }
  }

  const callNext = (serviceId: string, resourceId: string) =>
    run(async () => {
      const ticket = await api.callNext(locationId!, serviceId, resourceId);
      if (ticket === null) throw new ApiError(404, 'NOT_FOUND', 'Tidak ada tiket yang menunggu.');
    });
  const ticketAction = (ticket: Ticket, action: StaffTicketAction) =>
    run(() => api.ticketAction(ticket.id, action));
  const bookingAction = (booking: Booking, action: Parameters<typeof api.bookingAction>[1]) =>
    run(() => api.bookingAction(booking.id, action));
  const createTicket = (values: ManualTicketValues) =>
    run(() =>
      api.createTicket({
        location_id: locationId!,
        service_id: values.serviceId,
        customer_name: values.customerName,
        customer_phone: values.customerPhone,
      }),
    );

  if (locations.loading) return <Loading label="Memuat lokasi..." />;
  if (locations.error !== null) return <ErrorNotice message={locations.error} />;
  if (location === undefined) return <Empty>Belum ada lokasi aktif.</Empty>;

  const list = tickets.data ?? [];
  const metrics = computeMetrics(list);
  const groups = groupByService(list);

  return (
    <div className="stack">
      <div className="toolbar">
        <SelectField
          label="Lokasi"
          value={location.id}
          onChange={(event) => setChosenId(event.target.value)}
        >
          {activeLocations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </SelectField>
        <span className={`badge conn conn-${feed.status}`} role="status">
          {STATUS_TEXT[feed.status]}
        </span>
      </div>

      <ErrorNotice message={actionError ?? tickets.error ?? resources.error} />

      <dl className="metrics" aria-label="Ringkasan hari ini">
        <div>
          <dt>Menunggu</dt>
          <dd>{metrics.waiting}</dd>
        </div>
        <div>
          <dt>Sedang dilayani</dt>
          <dd>{metrics.inProgress}</dd>
        </div>
        <div>
          <dt>Selesai</dt>
          <dd>{metrics.completed}</dd>
        </div>
        <div>
          <dt>Rata-rata durasi</dt>
          <dd>
            {metrics.averageServiceMinutes === null ? '-' : `${metrics.averageServiceMinutes} mnt`}
          </dd>
        </div>
      </dl>

      {canCreateTicket(role) ? (
        <ManualTicketForm services={services.data ?? []} busy={busy} onSubmit={createTicket} />
      ) : null}

      <h2>Antrean hari ini</h2>
      {tickets.loading && tickets.data === undefined ? <Loading /> : null}
      {!tickets.loading && groups.length === 0 ? <Empty>Belum ada tiket hari ini.</Empty> : null}
      {groups.map((group) => (
        <ServiceQueue
          key={group.serviceId}
          serviceId={group.serviceId}
          serviceName={group.serviceName}
          tickets={group.tickets}
          resources={resources.data ?? []}
          role={role}
          busy={busy}
          onCallNext={(serviceId, resourceId) => void callNext(serviceId, resourceId)}
          onAction={(ticket, action) => void ticketAction(ticket, action)}
        />
      ))}

      <h2>Reservasi hari ini</h2>
      {bookings.error !== null ? <ErrorNotice message={bookings.error} /> : null}
      {bookings.loading && bookings.data === undefined ? (
        <Loading />
      ) : (
        <BookingList
          bookings={bookings.data ?? []}
          role={role}
          timeZone={location.timezone}
          busy={busy || !canActOnBookings(role)}
          onAction={(booking, action) => void bookingAction(booking, action)}
        />
      )}
    </div>
  );
}

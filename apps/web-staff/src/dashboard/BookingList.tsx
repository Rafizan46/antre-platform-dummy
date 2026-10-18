import type { UserRole } from '@antre/shared-types';

import type { Booking } from '../api/schemas';
import { Empty, formatTime } from '../components/ui';
import {
  BOOKING_ACTION_LABELS,
  BOOKING_STATUS_LABELS,
  bookingActionsFor,
  type StaffBookingAction,
} from '../lib/actions';

export function BookingList({
  bookings,
  role,
  timeZone,
  busy,
  onAction,
}: {
  bookings: Booking[];
  role: UserRole;
  timeZone: string;
  busy: boolean;
  onAction(booking: Booking, action: StaffBookingAction): void;
}) {
  if (bookings.length === 0) return <Empty>Belum ada reservasi hari ini.</Empty>;
  return (
    <ul className="ticket-list">
      {bookings.map((booking) => (
        <li key={booking.id} className={`ticket status-${booking.status.toLowerCase()}`}>
          <strong className="ticket-number">
            {formatTime(booking.start_time, timeZone)}-{formatTime(booking.end_time, timeZone)}
          </strong>
          <span className="ticket-name">
            {booking.customer_name} <span className="muted">({booking.service_name})</span>
          </span>
          <span className="badge">{BOOKING_STATUS_LABELS[booking.status]}</span>
          <span className="muted">{booking.resource_name}</span>
          <span className="ticket-actions">
            {bookingActionsFor(booking.status, role).map((action) => (
              <button
                key={action}
                type="button"
                disabled={busy}
                onClick={() => onAction(booking, action)}
                aria-label={`${BOOKING_ACTION_LABELS[action]} reservasi ${booking.customer_name}`}
              >
                {BOOKING_ACTION_LABELS[action]}
              </button>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

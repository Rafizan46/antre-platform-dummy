// Mapping of staff actions to the legal state transitions (shared-types) and to the roles the API
// allows: ticket actions OWNER + STAFF_CALLER, booking actions OWNER + STAFF_CASHIER (see
// apps/core-services queue/booking routes). Buttons are derived from here, never hard-coded.
import {
  STAFF_BOOKING_ACTIONS,
  STAFF_TICKET_ACTIONS,
  nextBookingStatus,
  nextTicketStatus,
  type BookingStatus,
  type TicketStatus,
  type UserRole,
} from '@antre/shared-types';

export type StaffTicketAction = (typeof STAFF_TICKET_ACTIONS)[number];
export type StaffBookingAction = (typeof STAFF_BOOKING_ACTIONS)[number];

export const TICKET_ACTION_LABELS: Record<StaffTicketAction, string> = {
  RECALL: 'Panggil ulang',
  SERVE: 'Layani',
  COMPLETE: 'Selesai',
  NO_SHOW: 'Tidak hadir',
};

export const BOOKING_ACTION_LABELS: Record<StaffBookingAction, string> = {
  COMPLETE: 'Selesai',
  NO_SHOW: 'Tidak hadir',
  CANCEL: 'Batalkan',
};

const CALLER_ROLES: readonly UserRole[] = ['OWNER', 'STAFF_CALLER'];
const CASHIER_ROLES: readonly UserRole[] = ['OWNER', 'STAFF_CASHIER'];

export const canCallTickets = (role: UserRole) => CALLER_ROLES.includes(role);
export const canCreateTicket = (role: UserRole) => CASHIER_ROLES.includes(role);
export const canActOnBookings = (role: UserRole) => CASHIER_ROLES.includes(role);

export function ticketActionsFor(status: TicketStatus, role: UserRole): StaffTicketAction[] {
  if (!canCallTickets(role)) return [];
  return STAFF_TICKET_ACTIONS.filter((action) => nextTicketStatus(status, action) !== null);
}

export function bookingActionsFor(status: BookingStatus, role: UserRole): StaffBookingAction[] {
  if (!canActOnBookings(role)) return [];
  return STAFF_BOOKING_ACTIONS.filter((action) => nextBookingStatus(status, action) !== null);
}

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  WAITING: 'Menunggu',
  CALLED: 'Dipanggil',
  SERVING: 'Dilayani',
  COMPLETED: 'Selesai',
  NO_SHOW: 'Tidak hadir',
  CANCELLED: 'Dibatalkan',
  EXPIRED: 'Kedaluwarsa',
};

export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  PENDING_PAYMENT: 'Menunggu pembayaran',
  CONFIRMED: 'Terkonfirmasi',
  COMPLETED: 'Selesai',
  NO_SHOW: 'Tidak hadir',
  CANCELLED: 'Dibatalkan',
  EXPIRED: 'Kedaluwarsa',
};

export const ROLE_LABELS: Record<UserRole, string> = {
  OWNER: 'Pemilik',
  STAFF_CALLER: 'Staf pemanggil',
  STAFF_CASHIER: 'Staf kasir',
  SUPER_ADMIN: 'Super Admin',
};

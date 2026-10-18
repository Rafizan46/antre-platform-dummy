// One function per endpoint used by the app; request bodies are the shared-types request types.
import type {
  BookingActionRequest,
  CreateResourceRequest,
  CreateServiceRequest,
  CreateStaffRequest,
  PutOperatingHoursRequest,
  RegisterRequest,
  UpdateResourceRequest,
  UpdateServiceRequest,
  UpdateStaffRequest,
  UpdateTenantSettingsRequest,
} from '@antre/shared-types';

import type { StaffTicketAction } from '../lib/actions';
import type { ApiClient } from './client';
import {
  billingOverviewSchema,
  bookingCalendarSchema,
  callNextResponseSchema,
  checkoutSchema,
  kioskTokenSchema,
  locationsResponseSchema,
  loginResponseSchema,
  operatingHoursSchema,
  resourceSchema,
  resourcesResponseSchema,
  serviceSchema,
  servicesResponseSchema,
  tenantSettingsSchema,
  ticketSchema,
  ticketsResponseSchema,
  userSchema,
  usersResponseSchema,
  type Booking,
} from './schemas';

export function createEndpoints(client: ApiClient) {
  return {
    login: (email: string, password: string) =>
      client.post('/api/v1/auth/login', {
        body: { email, password },
        schema: loginResponseSchema,
      }),
    register: (body: RegisterRequest) => client.post<unknown>('/api/v1/auth/register', { body }),

    locations: async () =>
      (await client.get('/api/v1/locations', { schema: locationsResponseSchema })).locations,

    services: async () =>
      (await client.get('/api/v1/catalog/services', { schema: servicesResponseSchema })).services,
    createService: (body: CreateServiceRequest) =>
      client.post('/api/v1/catalog/services', { body, schema: serviceSchema }),
    updateService: (id: string, body: UpdateServiceRequest) =>
      client.patch(`/api/v1/catalog/services/${id}`, { body, schema: serviceSchema }),

    resources: async (locationId: string) =>
      (
        await client.get('/api/v1/catalog/resources', {
          query: { location_id: locationId },
          schema: resourcesResponseSchema,
        })
      ).resources,
    createResource: (body: CreateResourceRequest) =>
      client.post('/api/v1/catalog/resources', { body, schema: resourceSchema }),
    updateResource: (id: string, body: UpdateResourceRequest) =>
      client.patch(`/api/v1/catalog/resources/${id}`, { body, schema: resourceSchema }),

    operatingHours: (locationId: string) =>
      client.get(`/api/v1/catalog/locations/${locationId}/operating-hours`, {
        schema: operatingHoursSchema,
      }),
    putOperatingHours: (locationId: string, body: PutOperatingHoursRequest) =>
      client.put(`/api/v1/catalog/locations/${locationId}/operating-hours`, {
        body,
        schema: operatingHoursSchema,
      }),

    tickets: async (locationId: string) =>
      (
        await client.get('/api/v1/queues/tickets', {
          query: { location_id: locationId },
          schema: ticketsResponseSchema,
        })
      ).tickets,
    createTicket: (body: {
      location_id: string;
      service_id: string;
      customer_name: string;
      customer_phone?: string;
    }) => client.post('/api/v1/queues/tickets', { body, schema: ticketSchema }),
    callNext: async (locationId: string, serviceId: string, resourceId: string) =>
      (
        await client.post('/api/v1/queues/tickets/call-next', {
          body: { location_id: locationId, service_id: serviceId, resource_id: resourceId },
          schema: callNextResponseSchema,
        })
      ).ticket,
    ticketAction: (id: string, action: StaffTicketAction) =>
      client.post(`/api/v1/queues/tickets/${id}/actions`, {
        body: { action },
        schema: ticketSchema,
      }),

    bookings: async (locationId: string, date: string): Promise<Booking[]> => {
      const calendar = await client.get('/api/v1/bookings', {
        query: { location_id: locationId, date },
        schema: bookingCalendarSchema,
      });
      const byId = new Map<string, Booking>();
      for (const slot of calendar.slots) {
        for (const cell of slot.resources) {
          if (cell.booking !== null) byId.set(cell.booking.id, cell.booking);
        }
      }
      return [...byId.values()].sort((a, b) => a.start_time.localeCompare(b.start_time));
    },
    bookingAction: (id: string, action: BookingActionRequest['action']) =>
      client.post<unknown>(`/api/v1/bookings/${id}/actions`, { body: { action } }),

    users: async () => (await client.get('/api/v1/users', { schema: usersResponseSchema })).users,
    createStaff: (body: CreateStaffRequest) =>
      client.post('/api/v1/users', { body, schema: userSchema }),
    updateStaff: (id: string, body: UpdateStaffRequest) =>
      client.patch(`/api/v1/users/${id}`, { body, schema: userSchema }),

    settings: () => client.get('/api/v1/tenants/me/settings', { schema: tenantSettingsSchema }),
    updateSettings: (body: UpdateTenantSettingsRequest) =>
      client.patch('/api/v1/tenants/me/settings', { body, schema: tenantSettingsSchema }),

    createKioskToken: (locationId: string) =>
      client.post(`/api/v1/locations/${locationId}/kiosk-tokens`, { schema: kioskTokenSchema }),
    revokeKioskTokens: (locationId: string) =>
      client.delete(`/api/v1/locations/${locationId}/kiosk-tokens`),

    billing: (locationId: string) =>
      client.get(`/api/v1/billing/locations/${locationId}/subscription`, {
        schema: billingOverviewSchema,
      }),
    checkout: (locationId: string) =>
      client.post(`/api/v1/billing/locations/${locationId}/subscription/checkout`, {
        schema: checkoutSchema,
      }),
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;

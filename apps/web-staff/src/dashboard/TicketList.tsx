import type { UserRole } from '@antre/shared-types';
import { useState } from 'react';

import type { Resource, Ticket } from '../api/schemas';
import { SelectField } from '../components/ui';
import {
  TICKET_ACTION_LABELS,
  TICKET_STATUS_LABELS,
  canCallTickets,
  ticketActionsFor,
  type StaffTicketAction,
} from '../lib/actions';

export interface ServiceQueueProps {
  serviceId: string;
  serviceName: string;
  tickets: Ticket[];
  resources: Resource[];
  role: UserRole;
  busy: boolean;
  onCallNext(serviceId: string, resourceId: string): void;
  onAction(ticket: Ticket, action: StaffTicketAction): void;
}

export function ServiceQueue({
  serviceId,
  serviceName,
  tickets,
  resources,
  role,
  busy,
  onCallNext,
  onAction,
}: ServiceQueueProps) {
  const eligible = resources.filter((r) => r.is_active && r.service_ids.includes(serviceId));
  const [resourceId, setResourceId] = useState('');
  const chosen = eligible.some((r) => r.id === resourceId) ? resourceId : (eligible[0]?.id ?? '');
  const waiting = tickets.filter((t) => t.status === 'WAITING').length;
  const headingId = `queue-${serviceId}`;

  return (
    <section className="card queue-card" aria-labelledby={headingId}>
      <header className="card-head">
        <h3 id={headingId}>
          {serviceName} <span className="badge">{waiting} menunggu</span>
        </h3>
        {canCallTickets(role) ? (
          <div className="inline-form">
            <SelectField
              id={`res-${serviceId}`}
              label={`Loket untuk ${serviceName}`}
              hideLabel
              value={chosen}
              onChange={(event) => setResourceId(event.target.value)}
              disabled={eligible.length === 0}
            >
              {eligible.length === 0 ? <option value="">Tidak ada loket</option> : null}
              {eligible.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </SelectField>
            <button
              type="button"
              className="primary"
              disabled={busy || chosen === '' || waiting === 0}
              onClick={() => onCallNext(serviceId, chosen)}
            >
              Panggil berikutnya
            </button>
          </div>
        ) : null}
      </header>
      <ul className="ticket-list">
        {tickets.map((ticket) => (
          <li key={ticket.id} className={`ticket status-${ticket.status.toLowerCase()}`}>
            <strong className="ticket-number">{ticket.ticket_number}</strong>
            <span className="ticket-name">{ticket.customer_name}</span>
            <span className={`badge badge-status badge-${ticket.status.toLowerCase()}`}>
              {TICKET_STATUS_LABELS[ticket.status]}
            </span>
            {ticket.resource_name !== null && ticket.status !== 'WAITING' ? (
              <span className="muted ticket-resource">{ticket.resource_name}</span>
            ) : null}
            <span className="ticket-actions">
              {ticketActionsFor(ticket.status, role).map((action) => (
                <button
                  key={action}
                  type="button"
                  disabled={busy}
                  onClick={() => onAction(ticket, action)}
                  aria-label={`${TICKET_ACTION_LABELS[action]} ${ticket.ticket_number}`}
                >
                  {TICKET_ACTION_LABELS[action]}
                </button>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

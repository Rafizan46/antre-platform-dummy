-- Up Migration
-- S05/S06: one ticket prefix per tenant (FR-QUEUE-02 numbers stay unambiguous per location)
-- and an index for the per-location day close (spec section 6.3).
ALTER TABLE services
    ADD CONSTRAINT services_tenant_id_ticket_prefix_key UNIQUE (tenant_id, ticket_prefix);

CREATE INDEX queue_tickets_active_location_date_idx
    ON queue_tickets (location_id, service_date)
    WHERE status IN ('WAITING', 'CALLED', 'SERVING');

-- Down Migration
DROP INDEX queue_tickets_active_location_date_idx;
ALTER TABLE services DROP CONSTRAINT services_tenant_id_ticket_prefix_key;

-- Up Migration
-- S08: one notification log row per tenant and event (FR-NOTIF-01, FR-NOTIF-05). The Notification
-- Worker claims the row with INSERT ... ON CONFLICT DO NOTHING plus SELECT ... FOR UPDATE, so a
-- redelivered or duplicated event (same event_id) is never sent twice. The constraint's index also
-- serves that lookup. No policy or GRANT changes: the row stays under tenant_isolation.
ALTER TABLE notification_logs
    ADD CONSTRAINT notification_logs_tenant_id_event_id_key UNIQUE (tenant_id, event_id);

-- Down Migration
ALTER TABLE notification_logs DROP CONSTRAINT notification_logs_tenant_id_event_id_key;

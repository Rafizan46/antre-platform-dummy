-- Up Migration
-- Core schema (spec sections 6.1-6.3 plus S02 decisions). Applied by antre_migrator, which
-- owns every object. Roles come from the database-admin bootstrap, not from this migration.

CREATE TABLE plans (
    code text PRIMARY KEY,
    name text NOT NULL,
    price_idr_per_month numeric(12, 2) NOT NULL,
    monthly_ticket_quota integer,
    CONSTRAINT plans_code_check CHECK (code ~ '^[A-Z][A-Z_]*$'),
    CONSTRAINT plans_price_check CHECK (price_idr_per_month >= 0),
    CONSTRAINT plans_quota_check CHECK (monthly_ticket_quota IS NULL OR monthly_ticket_quota > 0)
);

CREATE TABLE tenants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    slug text NOT NULL,
    business_type text NOT NULL,
    service_mode text NOT NULL DEFAULT 'BOTH',
    show_wait_estimate boolean NOT NULL DEFAULT true,
    admin_wa_phone text NOT NULL,
    branding jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tenants_slug_key UNIQUE (slug),
    CONSTRAINT tenants_slug_check CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) <= 63),
    CONSTRAINT tenants_business_type_check CHECK (business_type IN ('CLINIC', 'SPORTS', 'BARBERSHOP', 'OTHER')),
    CONSTRAINT tenants_service_mode_check CHECK (service_mode IN ('WALK_IN', 'RESERVATION', 'BOTH')),
    CONSTRAINT tenants_admin_wa_phone_check CHECK (admin_wa_phone ~ '^[1-9][0-9]{7,14}$'),
    CONSTRAINT tenants_branding_check CHECK (jsonb_typeof(branding) = 'object')
);

CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid REFERENCES tenants (id),
    email text NOT NULL,
    password_hash text NOT NULL,
    role text NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_email_key UNIQUE (email),
    CONSTRAINT users_email_check CHECK (email = lower(email)),
    CONSTRAINT users_role_check CHECK (role IN ('OWNER', 'STAFF_CALLER', 'STAFF_CASHIER', 'SUPER_ADMIN')),
    CONSTRAINT users_role_tenant_check CHECK ((role = 'SUPER_ADMIN') = (tenant_id IS NULL))
);

CREATE TABLE locations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants (id),
    code text NOT NULL,
    name text NOT NULL,
    address text,
    timezone text NOT NULL DEFAULT 'Asia/Jakarta',
    slot_interval_min integer NOT NULL DEFAULT 60,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT locations_tenant_id_id_key UNIQUE (tenant_id, id),
    CONSTRAINT locations_tenant_id_code_key UNIQUE (tenant_id, code),
    CONSTRAINT locations_code_check CHECK (code ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(code) <= 32),
    CONSTRAINT locations_timezone_check CHECK (timezone IN ('Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura')),
    CONSTRAINT locations_slot_interval_min_check CHECK (slot_interval_min > 0 AND slot_interval_min <= 1440)
);

CREATE TABLE operating_hours (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    location_id uuid NOT NULL,
    day_of_week integer NOT NULL,
    open_time time NOT NULL,
    close_time time NOT NULL,
    break_start time,
    break_end time,
    CONSTRAINT operating_hours_location_id_day_of_week_key UNIQUE (location_id, day_of_week),
    CONSTRAINT operating_hours_day_of_week_check CHECK (day_of_week BETWEEN 0 AND 6),
    CONSTRAINT operating_hours_open_close_check CHECK (open_time < close_time),
    CONSTRAINT operating_hours_break_pair_check CHECK ((break_start IS NULL) = (break_end IS NULL)),
    CONSTRAINT operating_hours_break_range_check CHECK (
        break_start IS NULL
        OR (open_time <= break_start AND break_start < break_end AND break_end <= close_time)
    ),
    CONSTRAINT operating_hours_location_fkey FOREIGN KEY (tenant_id, location_id)
        REFERENCES locations (tenant_id, id)
);

CREATE TABLE resources (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    location_id uuid NOT NULL,
    name text NOT NULL,
    resource_type text,
    is_active boolean NOT NULL DEFAULT true,
    CONSTRAINT resources_tenant_id_id_key UNIQUE (tenant_id, id),
    CONSTRAINT resources_tenant_id_location_id_id_key UNIQUE (tenant_id, location_id, id),
    CONSTRAINT resources_location_fkey FOREIGN KEY (tenant_id, location_id)
        REFERENCES locations (tenant_id, id)
);

CREATE TABLE services (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants (id),
    name text NOT NULL,
    ticket_prefix text NOT NULL,
    avg_duration_min integer NOT NULL,
    price numeric(12, 2) NOT NULL DEFAULT 0,
    requires_dp boolean NOT NULL DEFAULT false,
    dp_amount numeric(12, 2),
    is_active boolean NOT NULL DEFAULT true,
    CONSTRAINT services_tenant_id_id_key UNIQUE (tenant_id, id),
    CONSTRAINT services_ticket_prefix_check CHECK (ticket_prefix ~ '^[A-Z]{1,3}$'),
    CONSTRAINT services_avg_duration_min_check CHECK (avg_duration_min > 0),
    CONSTRAINT services_price_check CHECK (price >= 0),
    CONSTRAINT services_dp_check CHECK (requires_dp = (dp_amount IS NOT NULL)),
    CONSTRAINT services_dp_amount_check CHECK (dp_amount IS NULL OR dp_amount > 0)
);

CREATE TABLE service_resources (
    tenant_id uuid NOT NULL,
    service_id uuid NOT NULL,
    resource_id uuid NOT NULL,
    CONSTRAINT service_resources_pkey PRIMARY KEY (service_id, resource_id),
    CONSTRAINT service_resources_service_fkey FOREIGN KEY (tenant_id, service_id)
        REFERENCES services (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT service_resources_resource_fkey FOREIGN KEY (tenant_id, resource_id)
        REFERENCES resources (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE ticket_counters (
    tenant_id uuid NOT NULL,
    location_id uuid NOT NULL,
    service_id uuid NOT NULL,
    service_date date NOT NULL,
    last_seq integer NOT NULL,
    CONSTRAINT ticket_counters_pkey PRIMARY KEY (location_id, service_id, service_date),
    CONSTRAINT ticket_counters_last_seq_check CHECK (last_seq > 0),
    CONSTRAINT ticket_counters_location_fkey FOREIGN KEY (tenant_id, location_id)
        REFERENCES locations (tenant_id, id),
    CONSTRAINT ticket_counters_service_fkey FOREIGN KEY (tenant_id, service_id)
        REFERENCES services (tenant_id, id)
);

CREATE TABLE queue_tickets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    location_id uuid NOT NULL,
    resource_id uuid,
    service_id uuid NOT NULL,
    service_date date NOT NULL,
    ticket_number text NOT NULL,
    channel text NOT NULL,
    customer_name text NOT NULL,
    customer_phone text,
    status text NOT NULL DEFAULT 'WAITING',
    recall_count integer NOT NULL DEFAULT 0,
    estimated_serve_time timestamptz,
    near_turn_notified_at timestamptz,
    called_at timestamptz,
    serving_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT queue_tickets_ticket_number_key UNIQUE (location_id, service_id, service_date, ticket_number),
    CONSTRAINT queue_tickets_ticket_number_check CHECK (ticket_number ~ '^[A-Z]{1,3}-[0-9]{3,}$'),
    CONSTRAINT queue_tickets_channel_check CHECK (channel IN ('WHATSAPP', 'STAFF')),
    CONSTRAINT queue_tickets_status_check CHECK (
        status IN ('WAITING', 'CALLED', 'SERVING', 'COMPLETED', 'NO_SHOW', 'CANCELLED', 'EXPIRED')
    ),
    CONSTRAINT queue_tickets_customer_phone_check CHECK (customer_phone ~ '^[1-9][0-9]{7,14}$'),
    CONSTRAINT queue_tickets_channel_phone_check CHECK (channel = 'STAFF' OR customer_phone IS NOT NULL),
    CONSTRAINT queue_tickets_recall_count_check CHECK (recall_count >= 0),
    CONSTRAINT queue_tickets_location_fkey FOREIGN KEY (tenant_id, location_id)
        REFERENCES locations (tenant_id, id),
    CONSTRAINT queue_tickets_service_fkey FOREIGN KEY (tenant_id, service_id)
        REFERENCES services (tenant_id, id),
    CONSTRAINT queue_tickets_resource_fkey FOREIGN KEY (tenant_id, location_id, resource_id)
        REFERENCES resources (tenant_id, location_id, id)
);

-- One active ticket per WhatsApp number per location per operating day (FR-QUEUE-01).
CREATE UNIQUE INDEX queue_tickets_active_phone_key
    ON queue_tickets (location_id, customer_phone, service_date)
    WHERE status IN ('WAITING', 'CALLED', 'SERVING') AND customer_phone IS NOT NULL;

-- Lookup by phone for app_find_active_by_phone.
CREATE INDEX queue_tickets_active_customer_phone_idx
    ON queue_tickets (customer_phone)
    WHERE status IN ('WAITING', 'CALLED', 'SERVING');

CREATE TABLE bookings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    location_id uuid NOT NULL,
    resource_id uuid NOT NULL,
    service_id uuid NOT NULL,
    customer_name text NOT NULL,
    customer_phone text NOT NULL,
    start_time timestamptz NOT NULL,
    end_time timestamptz NOT NULL,
    status text NOT NULL,
    hold_token uuid NOT NULL,
    hold_expires_at timestamptz,
    dp_amount numeric(12, 2),
    dp_paid numeric(12, 2),
    payment_status text NOT NULL,
    payment_ref text,
    reminder_sent_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bookings_payment_ref_key UNIQUE (payment_ref),
    CONSTRAINT bookings_status_check CHECK (
        status IN ('PENDING_PAYMENT', 'CONFIRMED', 'COMPLETED', 'NO_SHOW', 'CANCELLED', 'EXPIRED')
    ),
    CONSTRAINT bookings_payment_status_check CHECK (
        payment_status IN ('NOT_REQUIRED', 'UNPAID', 'PAID', 'REFUND_PENDING')
    ),
    CONSTRAINT bookings_time_range_check CHECK (end_time > start_time),
    CONSTRAINT bookings_customer_phone_check CHECK (customer_phone ~ '^[1-9][0-9]{7,14}$'),
    CONSTRAINT bookings_dp_amount_check CHECK ((payment_status = 'NOT_REQUIRED') = (dp_amount IS NULL)),
    CONSTRAINT bookings_payment_ref_check CHECK ((payment_status = 'NOT_REQUIRED') = (payment_ref IS NULL)),
    CONSTRAINT bookings_pending_check CHECK (
        status <> 'PENDING_PAYMENT' OR (payment_status = 'UNPAID' AND hold_expires_at IS NOT NULL)
    ),
    CONSTRAINT bookings_amounts_check CHECK (
        (dp_amount IS NULL OR dp_amount > 0) AND (dp_paid IS NULL OR dp_paid >= 0)
    ),
    CONSTRAINT bookings_location_fkey FOREIGN KEY (tenant_id, location_id)
        REFERENCES locations (tenant_id, id),
    CONSTRAINT bookings_service_fkey FOREIGN KEY (tenant_id, service_id)
        REFERENCES services (tenant_id, id),
    CONSTRAINT bookings_resource_fkey FOREIGN KEY (tenant_id, location_id, resource_id)
        REFERENCES resources (tenant_id, location_id, id)
);

-- Final anti double-booking guarantee (FR-BOOKING-02, section 7.2).
CREATE UNIQUE INDEX bookings_active_slot_key
    ON bookings (resource_id, start_time)
    WHERE status IN ('PENDING_PAYMENT', 'CONFIRMED');

-- Lookup by phone for app_find_active_by_phone.
CREATE INDEX bookings_active_customer_phone_idx
    ON bookings (customer_phone)
    WHERE status IN ('PENDING_PAYMENT', 'CONFIRMED');

CREATE TABLE notification_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants (id),
    event_id text NOT NULL,
    provider_message_id text,
    recipient_phone text NOT NULL,
    template_name text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    delivery_status text NOT NULL DEFAULT 'QUEUED',
    retry_count integer NOT NULL DEFAULT 0,
    sent_at timestamptz,
    status_updated_at timestamptz,
    CONSTRAINT notification_logs_provider_message_id_key UNIQUE (provider_message_id),
    CONSTRAINT notification_logs_delivery_status_check CHECK (
        delivery_status IN ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'DLQ')
    ),
    CONSTRAINT notification_logs_recipient_phone_check CHECK (recipient_phone ~ '^[1-9][0-9]{7,14}$'),
    CONSTRAINT notification_logs_retry_count_check CHECK (retry_count >= 0)
);

CREATE TABLE subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    location_id uuid NOT NULL,
    plan_code text NOT NULL DEFAULT 'FREE' REFERENCES plans (code),
    status text NOT NULL DEFAULT 'ACTIVE',
    pending_plan_code text REFERENCES plans (code),
    payment_ref text,
    last_paid_ref text,
    pending_expires_at timestamptz,
    current_period_start timestamptz,
    current_period_end timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT subscriptions_location_id_key UNIQUE (location_id),
    CONSTRAINT subscriptions_payment_ref_key UNIQUE (payment_ref),
    CONSTRAINT subscriptions_status_check CHECK (status IN ('ACTIVE', 'PENDING_PAYMENT')),
    CONSTRAINT subscriptions_pending_plan_check CHECK (
        (status = 'PENDING_PAYMENT') = (pending_plan_code IS NOT NULL)
    ),
    CONSTRAINT subscriptions_pending_check CHECK (
        status <> 'PENDING_PAYMENT' OR (payment_ref IS NOT NULL AND pending_expires_at IS NOT NULL)
    ),
    CONSTRAINT subscriptions_period_check CHECK (
        (current_period_start IS NULL) = (current_period_end IS NULL)
        AND (current_period_end IS NULL OR current_period_end > current_period_start)
    ),
    CONSTRAINT subscriptions_location_fkey FOREIGN KEY (tenant_id, location_id)
        REFERENCES locations (tenant_id, id)
);

CREATE TABLE usage_counters (
    location_id uuid NOT NULL,
    period_month date NOT NULL,
    tenant_id uuid NOT NULL,
    ticket_count integer NOT NULL DEFAULT 0,
    warning_sent_at timestamptz,
    exceeded_sent_at timestamptz,
    CONSTRAINT usage_counters_pkey PRIMARY KEY (location_id, period_month),
    CONSTRAINT usage_counters_ticket_count_check CHECK (ticket_count >= 0),
    CONSTRAINT usage_counters_period_month_check CHECK (extract(day FROM period_month) = 1),
    CONSTRAINT usage_counters_location_fkey FOREIGN KEY (tenant_id, location_id)
        REFERENCES locations (tenant_id, id)
);

-- Row-level security: ENABLE + FORCE on all 13 tenant-dependent tables (plans stays global).
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE operating_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;

ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE locations FORCE ROW LEVEL SECURITY;
ALTER TABLE operating_hours FORCE ROW LEVEL SECURITY;
ALTER TABLE resources FORCE ROW LEVEL SECURITY;
ALTER TABLE services FORCE ROW LEVEL SECURITY;
ALTER TABLE service_resources FORCE ROW LEVEL SECURITY;
ALTER TABLE ticket_counters FORCE ROW LEVEL SECURITY;
ALTER TABLE queue_tickets FORCE ROW LEVEL SECURITY;
ALTER TABLE bookings FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_counters FORCE ROW LEVEL SECURITY;

-- Runtime tenant isolation for antre_app (section 6.1).
CREATE POLICY tenant_isolation ON tenants
    FOR ALL TO antre_app
    USING (id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON users
    FOR ALL TO antre_app
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON locations
    FOR ALL TO antre_app
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON operating_hours
    FOR ALL TO antre_app
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON resources
    FOR ALL TO antre_app
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON services
    FOR ALL TO antre_app
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON service_resources
    FOR ALL TO antre_app
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON ticket_counters
    FOR ALL TO antre_app
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON queue_tickets
    FOR ALL TO antre_app
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON bookings
    FOR ALL TO antre_app
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON notification_logs
    FOR ALL TO antre_app
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON subscriptions
    FOR ALL TO antre_app
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON usage_counters
    FOR ALL TO antre_app
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Cross-tenant reads for the SECURITY DEFINER functions (owner antre_definer, NOBYPASSRLS).
-- The column GRANTs below are the boundary of what antre_definer can read or change.
CREATE POLICY definer_read ON tenants FOR SELECT TO antre_definer USING (true);
CREATE POLICY definer_read ON users FOR SELECT TO antre_definer USING (true);
CREATE POLICY definer_read ON locations FOR SELECT TO antre_definer USING (true);
CREATE POLICY definer_read ON queue_tickets FOR SELECT TO antre_definer USING (true);
CREATE POLICY definer_read ON bookings FOR SELECT TO antre_definer USING (true);
CREATE POLICY definer_read ON subscriptions FOR SELECT TO antre_definer USING (true);
CREATE POLICY definer_read ON notification_logs FOR SELECT TO antre_definer USING (true);
CREATE POLICY definer_update ON notification_logs
    FOR UPDATE TO antre_definer USING (true) WITH CHECK (true);

-- Read-only cross-tenant access for the Super Admin console (FR-ADMIN-01, NOBYPASSRLS).
CREATE POLICY platform_admin_read ON tenants FOR SELECT TO antre_platform_admin USING (true);
CREATE POLICY platform_admin_read ON locations FOR SELECT TO antre_platform_admin USING (true);
CREATE POLICY platform_admin_read ON subscriptions FOR SELECT TO antre_platform_admin USING (true);
CREATE POLICY platform_admin_read ON usage_counters FOR SELECT TO antre_platform_admin USING (true);

-- SUPER_ADMIN provisioning by the platform operator connected as antre_migrator. Only rows
-- without a tenant are visible or writable; tenant rows stay hidden from the table owner.
CREATE POLICY super_admin_provisioning ON users
    FOR ALL TO antre_migrator
    USING (tenant_id IS NULL)
    WITH CHECK (tenant_id IS NULL AND role = 'SUPER_ADMIN');

-- Privileges (section 6.1). antre_migrator owns every table; nothing is granted to PUBLIC.
GRANT SELECT, INSERT, UPDATE, DELETE ON
    tenants, users, locations, operating_hours, resources, services, service_resources,
    ticket_counters, queue_tickets, bookings, notification_logs, subscriptions, usage_counters
    TO antre_app;
GRANT SELECT ON plans TO antre_app;
GRANT SELECT ON tenants, locations, plans, subscriptions, usage_counters TO antre_platform_admin;

-- antre_definer: only the columns read or changed by the closed list of SECURITY DEFINER functions.
GRANT SELECT (id, tenant_id, email, password_hash, role, is_active) ON users TO antre_definer;
GRANT SELECT (id, slug) ON tenants TO antre_definer;
GRANT SELECT (id, tenant_id, code, timezone, is_active) ON locations TO antre_definer;
GRANT SELECT (id, tenant_id, location_id, service_date, customer_phone, status)
    ON queue_tickets TO antre_definer;
GRANT SELECT (id, tenant_id, location_id, customer_phone, status, start_time, hold_expires_at, reminder_sent_at)
    ON bookings TO antre_definer;
GRANT SELECT (id, tenant_id, status, plan_code, pending_expires_at, current_period_end)
    ON subscriptions TO antre_definer;
GRANT SELECT (provider_message_id, delivery_status), UPDATE (delivery_status, status_updated_at)
    ON notification_logs TO antre_definer;

-- Seed: plan catalog (FR-BILLING-01). FREE = 100 tickets per calendar month per location;
-- PAID_LOCATION = Rp150.000 per location per month with unlimited tickets (quota NULL).
INSERT INTO plans (code, name, price_idr_per_month, monthly_ticket_quota) VALUES
    ('FREE', 'Gratis', 0, 100),
    ('PAID_LOCATION', 'Berbayar per Lokasi', 150000, NULL);

-- Down Migration
DROP TABLE
    usage_counters, subscriptions, notification_logs, bookings, queue_tickets, ticket_counters,
    service_resources, services, resources, operating_hours, locations, users, tenants, plans;

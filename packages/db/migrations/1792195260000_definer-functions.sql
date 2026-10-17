-- Up Migration
-- Closed list of SECURITY DEFINER functions (spec section 6.1). Every function: owner
-- antre_definer, fixed search_path ending in pg_temp, EXECUTE revoked from PUBLIC and granted
-- only to antre_app. GRANT/REVOKE run before ALTER ... OWNER because antre_migrator is a
-- member of antre_definer WITH INHERIT FALSE (it may SET ROLE but does not act as the owner).

CREATE FUNCTION app_auth_find_user(p_email text)
RETURNS TABLE (id uuid, tenant_id uuid, password_hash text, role text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT u.id, u.tenant_id, u.password_hash, u.role
    FROM users AS u
    WHERE u.email = lower(p_email)
      AND u.is_active
$$;
REVOKE ALL ON FUNCTION app_auth_find_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_auth_find_user(text) TO antre_app;
ALTER FUNCTION app_auth_find_user(text) OWNER TO antre_definer;

CREATE FUNCTION app_resolve_location(p_slug text, p_location_code text)
RETURNS TABLE (tenant_id uuid, location_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT l.tenant_id, l.id
    FROM tenants AS t
    JOIN locations AS l ON l.tenant_id = t.id
    WHERE t.slug = lower(p_slug)
      AND l.code = lower(p_location_code)
      AND l.is_active
$$;
REVOKE ALL ON FUNCTION app_resolve_location(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_resolve_location(text, text) TO antre_app;
ALTER FUNCTION app_resolve_location(text, text) OWNER TO antre_definer;

-- Active tickets of the current operating day (service_date = local date of the location)
-- and upcoming bookings across all tenants, at most 10 rows: tickets first, then bookings by
-- start_time.
CREATE FUNCTION app_find_active_by_phone(p_customer_phone text)
RETURNS TABLE (kind text, tenant_id uuid, location_id uuid, item_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT a.kind, a.tenant_id, a.location_id, a.item_id
    FROM (
        SELECT 'TICKET'::text AS kind, t.tenant_id, t.location_id, t.id AS item_id,
               0 AS kind_order, NULL::timestamptz AS start_time
        FROM queue_tickets AS t
        JOIN locations AS l ON l.id = t.location_id
        WHERE t.customer_phone = p_customer_phone
          AND t.status IN ('WAITING', 'CALLED', 'SERVING')
          AND t.service_date = (now() AT TIME ZONE l.timezone)::date
        UNION ALL
        SELECT 'BOOKING'::text, b.tenant_id, b.location_id, b.id, 1, b.start_time
        FROM bookings AS b
        WHERE b.customer_phone = p_customer_phone
          AND b.status IN ('PENDING_PAYMENT', 'CONFIRMED')
          AND b.start_time > now()
    ) AS a
    ORDER BY a.kind_order, a.start_time, a.item_id
    LIMIT 10
$$;
REVOKE ALL ON FUNCTION app_find_active_by_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_find_active_by_phone(text) TO antre_app;
ALTER FUNCTION app_find_active_by_phone(text) OWNER TO antre_definer;

-- Forward-only delivery status update by wamid: SENT -> DELIVERED -> READ, or FAILED from
-- QUEUED/SENT. Returns the number of updated rows (0 = untenanted message, unknown wamid, or
-- an out-of-order status).
CREATE FUNCTION app_wa_update_delivery_status(
    p_provider_message_id text,
    p_status text,
    p_status_at timestamptz
)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_updated integer;
BEGIN
    IF p_status IS NULL OR p_status NOT IN ('SENT', 'DELIVERED', 'READ', 'FAILED') THEN
        RAISE EXCEPTION 'invalid delivery status: %', p_status USING ERRCODE = '22023';
    END IF;

    UPDATE notification_logs AS n
    SET delivery_status = p_status,
        status_updated_at = p_status_at
    WHERE n.provider_message_id = p_provider_message_id
      AND n.delivery_status = ANY (
          CASE p_status
              WHEN 'SENT' THEN ARRAY['QUEUED']
              WHEN 'DELIVERED' THEN ARRAY['QUEUED', 'SENT']
              WHEN 'READ' THEN ARRAY['QUEUED', 'SENT', 'DELIVERED']
              ELSE ARRAY['QUEUED', 'SENT']
          END
      );
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated;
END;
$$;
REVOKE ALL ON FUNCTION app_wa_update_delivery_status(text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_wa_update_delivery_status(text, text, timestamptz) TO antre_app;
ALTER FUNCTION app_wa_update_delivery_status(text, text, timestamptz) OWNER TO antre_definer;

CREATE FUNCTION app_due_booking_holds()
RETURNS TABLE (tenant_id uuid, id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT b.tenant_id, b.id
    FROM bookings AS b
    WHERE b.status = 'PENDING_PAYMENT'
      AND b.hold_expires_at <= now()
$$;
REVOKE ALL ON FUNCTION app_due_booking_holds() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_due_booking_holds() TO antre_app;
ALTER FUNCTION app_due_booking_holds() OWNER TO antre_definer;

CREATE FUNCTION app_due_booking_reminders()
RETURNS TABLE (tenant_id uuid, id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT b.tenant_id, b.id
    FROM bookings AS b
    WHERE b.status = 'CONFIRMED'
      AND b.start_time > now()
      AND b.start_time <= now() + interval '30 minutes'
      AND b.reminder_sent_at IS NULL
$$;
REVOKE ALL ON FUNCTION app_due_booking_reminders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_due_booking_reminders() TO antre_app;
ALTER FUNCTION app_due_booking_reminders() OWNER TO antre_definer;

CREATE FUNCTION app_due_subscriptions()
RETURNS TABLE (tenant_id uuid, id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT s.tenant_id, s.id
    FROM subscriptions AS s
    WHERE (s.status = 'PENDING_PAYMENT' AND s.pending_expires_at <= now())
       OR (s.plan_code = 'PAID_LOCATION' AND s.current_period_end <= now())
$$;
REVOKE ALL ON FUNCTION app_due_subscriptions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_due_subscriptions() TO antre_app;
ALTER FUNCTION app_due_subscriptions() OWNER TO antre_definer;

-- Down Migration
-- The functions are owned by antre_definer; antre_migrator may SET ROLE to it (SET TRUE).
SET LOCAL ROLE antre_definer;
DROP FUNCTION
    app_due_subscriptions(),
    app_due_booking_reminders(),
    app_due_booking_holds(),
    app_wa_update_delivery_status(text, text, timestamptz),
    app_find_active_by_phone(text),
    app_resolve_location(text, text),
    app_auth_find_user(text);
RESET ROLE;

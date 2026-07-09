-- Planning view for the "Available orders" surface (dispatcher + warehouse).
-- Role-gated in the WHERE clause: admin/dispatcher, warehouse, or the assigned
-- agent. Owned by postgres with security_invoker OFF, so it intentionally
-- bypasses base-table RLS on deliveries (warehouse has no direct select grant)
-- and visibility is governed solely by the is_warehouse()/is_admin_or_dispatcher()
-- guard below.
--
-- bot_raw_message re-exposes the original WhatsApp text (customer name/phone/
-- address) to the warehouse manager — an intentional decision (Uzo, 2026-06-21)
-- so the warehouse can sanity-check the order against the source text. The rest
-- of the view still omits the parsed phone/address/price columns.
--
-- has_raw_message (appended LAST so CREATE OR REPLACE VIEW stays valid — you may
-- only add columns at the end) is a lightweight boolean the list query selects
-- INSTEAD of the full bot_raw_message text, to cut egress: the app's list fetch
-- ships this ~1-byte flag (drives the row's "view message" hint) and lazily
-- fetches bot_raw_message for a single order only when the sheet is opened.
CREATE OR REPLACE VIEW public.available_orders_safe AS
 SELECT d.id AS delivery_id,
    d.assigned_agent_id AS agent_id,
    u.display_name AS agent_name,
    d.client_id,
    c.name AS client_name,
    di.product_catalog_id,
    p.product_name,
    di.quantity_ordered,
    d.customer_name,
    d.location_id,
    l.name AS location_name,
    d.scheduled_date,
    d.current_status,
    d.bot_raw_message,
    (d.bot_raw_message IS NOT NULL) AS has_raw_message
   FROM deliveries d
     JOIN users u ON u.id = d.assigned_agent_id
     JOIN clients c ON c.id = d.client_id
     JOIN delivery_items di ON di.delivery_id = d.id
     JOIN product_catalog p ON p.id = di.product_catalog_id
     LEFT JOIN locations l ON l.id = d.location_id
  WHERE d.deleted_at IS NULL
    AND (d.current_status = ANY (ARRAY['available'::text, 'available_evening'::text]))
    AND d.assigned_agent_id IS NOT NULL
    AND (is_admin_or_dispatcher() OR is_warehouse() OR d.assigned_agent_id = auth.uid());

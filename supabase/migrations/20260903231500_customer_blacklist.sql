-- Customer blacklist — refuse orders from known time-wasters, keyed on the
-- phone number.
--
-- Greg's card (2026-08-28): a handful of people place orders across vendors
-- purely to cause failed deliveries, and change their name between orders.
-- The name is not identity; the number is. Every order path (bot, manual form,
-- needs-review fix) already funnels through create_delivery, so the guard lives
-- there, keyed on the same normalized form (_norm_phone) the duplicate matcher
-- uses — "+234 803…", "0803…" and "803…" are one key. The alternate phone is
-- checked too: someone who rotates names rotates which number goes first.
--
-- A refusal is a structured P0001 (hint.kind = 'blacklisted'), the pattern
-- bot_create_delivery already uses for duplicate_same_agent. bot-parse-message
-- files the message as `blocked` (new inbound status) instead of `error`, so
-- ops see it in the review queue's Blocked tab with the vendor and the reason,
-- tell the vendor, and notice when the same number reappears under a new name.
--
-- Nothing here touches stock, money or the status machine. Removing an entry is
-- a close, not a delete: the history stays and both directions are audited.
begin;

create table if not exists public.customer_blacklist (
  id                 uuid primary key default gen_random_uuid(),
  phone_normalized   text not null,
  phone_display      text not null,          -- as typed, for humans
  reason             text not null,
  source_delivery_id uuid references public.deliveries(id),
  added_by           uuid not null references public.users(id),
  added_at           timestamptz not null default now(),
  removed_by         uuid references public.users(id),
  removed_at         timestamptz,
  removal_note       text
);
-- One ACTIVE entry per number; removed entries stay as history.
create unique index if not exists customer_blacklist_active_phone_idx
  on public.customer_blacklist(phone_normalized) where removed_at is null;
create index if not exists customer_blacklist_added_idx
  on public.customer_blacklist(added_at desc);
alter table public.customer_blacklist enable row level security;
revoke all on public.customer_blacklist from anon, authenticated;
grant select on public.customer_blacklist to authenticated;
drop policy if exists customer_blacklist_select on public.customer_blacklist;
-- is_admin_or_dispatcher() includes rep: all ops roles can read, riders cannot.
create policy customer_blacklist_select on public.customer_blacklist
  for select to authenticated using (public.is_admin_or_dispatcher());
-- Writes only through the RPCs below (security definer). No insert/update policy.

-- The bot files refused orders as `blocked`.
alter table public.bot_inbound_messages drop constraint if exists bot_inbound_messages_status_check;
alter table public.bot_inbound_messages add constraint bot_inbound_messages_status_check
  check (status = any (array['queued','parsed','shadow_only','needs_review','created_delivery','duplicate','error','blocked']));
-- list_customer_blacklist counts how many orders each entry has blocked.
create index if not exists bot_inbound_blocked_entry_idx
  on public.bot_inbound_messages ((parse_result->'blacklist'->>'entry_id')) where status = 'blocked';

-- ---------------------------------------------------------------------------
-- Internal helpers (postgres-only; see project_box_function_grants)
-- ---------------------------------------------------------------------------

-- The active entry matching either number, primary first. Null row when clean.
create or replace function public._customer_blacklist_hit(p_phone text, p_phone_alt text)
returns public.customer_blacklist
language sql stable set search_path = public
as $fn$
  select b.* from public.customer_blacklist b
   where b.removed_at is null
     and b.phone_normalized in (public._norm_phone(p_phone), public._norm_phone(p_phone_alt))
   order by (b.phone_normalized = public._norm_phone(p_phone)) desc, b.added_at desc
   limit 1;
$fn$;

-- The one gate. Raises the structured refusal both order paths rely on.
create or replace function public._assert_customer_not_blacklisted(p_phone text, p_phone_alt text)
returns void
language plpgsql set search_path = public
as $fn$
declare
  v_hit public.customer_blacklist;
begin
  v_hit := public._customer_blacklist_hit(p_phone, p_phone_alt);
  if v_hit.id is not null then
    raise exception 'Customer number % is blacklisted: %', v_hit.phone_display, v_hit.reason
      using errcode = 'P0001',
            hint = jsonb_build_object(
              'kind', 'blacklisted', 'entry_id', v_hit.id,
              'phone', v_hit.phone_display, 'reason', v_hit.reason,
              'matched_on', case when v_hit.phone_normalized = public._norm_phone(p_phone)
                                 then 'phone' else 'alt' end)::text;
  end if;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- App-facing RPCs
-- ---------------------------------------------------------------------------

-- Managers add a number. Idempotent: re-adding an active number returns the
-- existing entry with already_listed = true rather than a twin. open_orders is
-- how many non-terminal deliveries still carry the number — shown so ops can
-- close them deliberately; nothing is auto-cancelled.
create or replace function public.add_customer_blacklist(
  p_phone text, p_reason text, p_source_delivery_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, auth
as $fn$
declare
  v_actor    uuid := auth.uid();
  v_norm     text := public._norm_phone(p_phone);
  v_display  text := nullif(trim(p_phone), '');
  v_reason   text := nullif(trim(p_reason), '');
  v_row      public.customer_blacklist;
  v_open     integer;
  v_existing boolean := false;
begin
  if not public.is_manager() then
    raise exception 'permission denied: admin or dispatcher only' using errcode = '42501';
  end if;
  if v_norm is null or length(v_norm) < 7 then
    raise exception 'Enter a phone number with at least 7 digits' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  if p_source_delivery_id is not null
     and not exists (select 1 from public.deliveries where id = p_source_delivery_id) then
    raise exception 'Delivery not found' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('customer-blacklist:' || v_norm, 0));
  select * into v_row from public.customer_blacklist
   where phone_normalized = v_norm and removed_at is null;
  if found then
    v_existing := true;
  else
    insert into public.customer_blacklist(phone_normalized, phone_display, reason, source_delivery_id, added_by)
      values (v_norm, v_display, v_reason, p_source_delivery_id, v_actor)
      returning * into v_row;
    perform public.write_audit('customer_blacklist', v_row.id, null,
      jsonb_build_object('phone_normalized', v_norm, 'phone_display', v_display,
        'reason', v_reason, 'source_delivery_id', p_source_delivery_id),
      'blacklist customer number', v_actor);
  end if;

  select count(*) into v_open
    from public.deliveries d
    join public.delivery_status_defs sd on sd.status = d.current_status
   where d.deleted_at is null and sd.category <> 'terminal'
     and (d.customer_phone_normalized = v_norm or public._norm_phone(d.customer_phone_alt) = v_norm);

  return jsonb_build_object(
    'id', v_row.id, 'phone_display', v_row.phone_display, 'phone_normalized', v_row.phone_normalized,
    'reason', v_row.reason, 'added_at', v_row.added_at,
    'already_listed', v_existing, 'open_orders', v_open);
end;
$fn$;

-- Managers close an entry. Idempotent on an already-removed entry.
create or replace function public.remove_customer_blacklist(p_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path = public, auth
as $fn$
declare
  v_actor uuid := auth.uid();
  v_row   public.customer_blacklist;
begin
  if not public.is_manager() then
    raise exception 'permission denied: admin or dispatcher only' using errcode = '42501';
  end if;
  select * into v_row from public.customer_blacklist where id = p_id for update;
  if not found then raise exception 'Blacklist entry not found' using errcode = '22023'; end if;
  if v_row.removed_at is not null then return; end if;
  update public.customer_blacklist
     set removed_by = v_actor, removed_at = now(), removal_note = nullif(trim(p_note), '')
   where id = p_id;
  -- write_audit logs one row per key whose value changed, so old/new carry the
  -- same keys: only removed_at and removal_note actually change here.
  perform public.write_audit('customer_blacklist', p_id,
    jsonb_build_object('removed_at', null, 'removal_note', null),
    jsonb_build_object('removed_at', now(), 'removal_note', nullif(trim(p_note), '')),
    'remove customer number from blacklist', v_actor);
end;
$fn$;

-- Ops: is this number (or its alternate) listed? Null when clean. Powers the
-- inline warning on the delivery form and the Blacklisted marker on a delivery.
create or replace function public.check_customer_blacklist(p_phone text, p_phone_alt text default null)
returns jsonb
language plpgsql stable security definer set search_path = public, auth
as $fn$
declare
  v_hit  public.customer_blacklist;
  v_name text;
begin
  if not public.is_admin_or_dispatcher() then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  v_hit := public._customer_blacklist_hit(p_phone, p_phone_alt);
  if v_hit.id is null then return null; end if;
  select display_name into v_name from public.users where id = v_hit.added_by;
  return jsonb_build_object(
    'id', v_hit.id, 'phone_display', v_hit.phone_display, 'reason', v_hit.reason,
    'added_at', v_hit.added_at, 'added_by_name', v_name,
    'source_delivery_id', v_hit.source_delivery_id,
    'matched_on', case when v_hit.phone_normalized = public._norm_phone(p_phone)
                       then 'phone' else 'alt' end);
end;
$fn$;

-- Ops: the list, with names and how many bot orders each entry has refused.
create or replace function public.list_customer_blacklist(p_include_removed boolean default false)
returns table(
  id uuid, phone_normalized text, phone_display text, reason text, source_delivery_id uuid,
  added_by uuid, added_by_name text, added_at timestamptz,
  removed_by uuid, removed_by_name text, removed_at timestamptz, removal_note text,
  blocked_count integer, last_blocked_at timestamptz)
language plpgsql stable security definer set search_path = public, auth
as $fn$
begin
  if not public.is_admin_or_dispatcher() then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  return query
  select b.id, b.phone_normalized, b.phone_display, b.reason, b.source_delivery_id,
         b.added_by, a.display_name::text, b.added_at,
         b.removed_by, r.display_name::text, b.removed_at, b.removal_note,
         coalesce(m.n, 0)::integer, m.last_at
    from public.customer_blacklist b
    left join public.users a on a.id = b.added_by
    left join public.users r on r.id = b.removed_by
    left join lateral (
      select count(*) as n, max(i.received_at) as last_at
        from public.bot_inbound_messages i
       where i.status = 'blocked'
         and i.parse_result->'blacklist'->>'entry_id' = b.id::text
    ) m on true
   where coalesce(p_include_removed, false) or b.removed_at is null
   order by (b.removed_at is null) desc, b.added_at desc;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- The gate, on both order paths
-- ---------------------------------------------------------------------------

-- create_delivery: identical to tools/live-defs/create_delivery.sql (captured
-- 2026-09-03) plus ONE line — the blacklist assert right after the field checks.
CREATE OR REPLACE FUNCTION public.create_delivery(p_client_uuid text, p_client_id uuid, p_product_catalog_id uuid, p_customer_name text, p_customer_phone text, p_raw_address text, p_quantity_ordered integer, p_customer_price numeric, p_location_id uuid DEFAULT NULL::uuid, p_scheduled_date date DEFAULT CURRENT_DATE, p_assigned_agent_id uuid DEFAULT NULL::uuid, p_created_via text DEFAULT 'manual'::text, p_bot_raw_message text DEFAULT NULL::text, p_customer_phone_alt text DEFAULT NULL::text, p_items jsonb DEFAULT NULL::jsonb, p_delivery_instructions text DEFAULT NULL::text, p_client_rep text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_existing       uuid;
  v_delivery_id    uuid;
  v_charged        numeric;
  v_agent_payment  numeric;
  v_customer_name  text := nullif(trim(p_customer_name), '');
  v_customer_phone text := nullif(trim(p_customer_phone), '');
  v_customer_phone_alt text := nullif(trim(p_customer_phone_alt), '');
  v_raw_address    text := nullif(trim(p_raw_address), '');
  v_delivery_instructions text := nullif(trim(p_delivery_instructions), '');
  v_client_rep     text := nullif(trim(p_client_rep), '');
  v_actor          uuid := auth.uid();
  v_fingerprint    text := public._text_fingerprint(p_bot_raw_message);
  v_phone_norm     text := public._norm_phone(p_customer_phone);
  v_original_date  date := p_scheduled_date;
  v_bumped         boolean := false;
  v_items          jsonb;
  v_items_fp       text;
begin
  if not public.is_manager() then
    raise exception 'permission denied: admin or dispatcher only' using errcode = '42501';
  end if;
  if p_client_uuid is null or trim(p_client_uuid) = '' then
    raise exception 'client_uuid required' using errcode = '23514';
  end if;

  select delivery_id into v_existing
    from public.delivery_status_history where client_uuid = p_client_uuid limit 1;
  if v_existing is not null then return v_existing; end if;

  if v_customer_name  is null then raise exception 'customer_name required'  using errcode = '23514'; end if;
  if v_customer_phone is null then raise exception 'customer_phone required' using errcode = '23514'; end if;
  if v_raw_address    is null then raise exception 'raw_address required'    using errcode = '23514'; end if;
  if p_quantity_ordered is null or p_quantity_ordered <= 0 then
    raise exception 'quantity_ordered must be > 0' using errcode = '23514';
  end if;
  if p_customer_price is null or p_customer_price < 0 then
    raise exception 'customer_price must be >= 0' using errcode = '23514';
  end if;
  if p_created_via not in ('manual', 'bot') then
    raise exception 'invalid created_via' using errcode = '23514';
  end if;

  -- Customer blacklist: refuse before anything is written (structured P0001).
  perform public._assert_customer_not_blacklisted(p_customer_phone, p_customer_phone_alt);

  p_scheduled_date := public._effective_scheduled_date(p_scheduled_date, p_created_via);
  v_bumped := (p_scheduled_date is distinct from v_original_date);

  if not exists (select 1 from public.clients where id = p_client_id and is_active = true) then
    raise exception 'client is inactive or not found' using errcode = '23514';
  end if;

  v_items := coalesce(p_items, jsonb_build_array(jsonb_build_object(
    'product_catalog_id', p_product_catalog_id, 'quantity_ordered', p_quantity_ordered,
    'customer_price', p_customer_price)));

  if exists (
    select 1 from jsonb_array_elements(v_items) e
     where not exists (
       select 1 from public.product_catalog pc
        where pc.id = (e->>'product_catalog_id')::uuid
          and pc.client_id = p_client_id and pc.is_active = true)
  ) then
    raise exception 'a line item product is inactive or does not belong to client' using errcode = '23514';
  end if;

  v_items_fp := public._delivery_items_sig(v_items);   -- [Feature A] dedup identity

  -- Same-agent sibling guard — manual creates only, re-keyed to items_fingerprint.
  if p_created_via = 'manual'
     and p_assigned_agent_id is not null
     and v_phone_norm is not null
     and exists (
       select 1
         from public.deliveries d
         join public.delivery_status_defs sd on sd.status = d.current_status
        where d.assigned_agent_id          = p_assigned_agent_id
          and d.customer_phone_normalized  = v_phone_norm
          and d.items_fingerprint          = v_items_fp           -- [Feature A]
          and (d.scheduled_date = p_scheduled_date or d.current_status = 'postponed')
          and d.deleted_at is null
          and sd.category <> 'terminal'
          and (
            (v_fingerprint is not null and d.text_fingerprint is not null and d.text_fingerprint = v_fingerprint)
            or
            ((v_fingerprint is null or d.text_fingerprint is null)
             and public._norm_address(d.raw_address) = public._norm_address(v_raw_address))
          )
     )
  then
    raise exception 'agent % already has an open delivery matching this customer + items + date',
      coalesce((select u.display_name from public.users u where u.id = p_assigned_agent_id), p_assigned_agent_id::text)
      using errcode = '23505', hint = 'reassign to a different agent';
  end if;

  if p_location_id is not null then
    select er.charged, er.agent_payment into v_charged, v_agent_payment
      from public.effective_rate(p_location_id, p_client_id, null) er;
  end if;

  insert into public.deliveries (
    client_id, product_catalog_id, location_id,
    customer_name, customer_phone, customer_phone_alt, raw_address,
    quantity_ordered, customer_price, charged_snapshot, agent_payment_snapshot,
    scheduled_date, assigned_agent_id, created_by_user_id,
    current_status, created_via, bot_raw_message, text_fingerprint,
    delivery_instructions, client_rep
  ) values (
    p_client_id, p_product_catalog_id, p_location_id,
    v_customer_name, v_customer_phone, v_customer_phone_alt, v_raw_address,
    p_quantity_ordered, p_customer_price, v_charged, v_agent_payment,
    p_scheduled_date, p_assigned_agent_id, v_actor,
    'pending', p_created_via, p_bot_raw_message, v_fingerprint,
    v_delivery_instructions, v_client_rep
  ) returning id into v_delivery_id;

  v_items_fp := public._apply_delivery_items(v_delivery_id, v_items);

  insert into public.delivery_status_history (
    delivery_id, from_status, to_status, changed_by_user_id, client_uuid, effective_at
  ) values (v_delivery_id, null, 'pending', v_actor, p_client_uuid, now());

  perform public.write_audit(
    'delivery', v_delivery_id, null,
    jsonb_build_object(
      'client_id', p_client_id, 'product_catalog_id', p_product_catalog_id,
      'location_id', p_location_id, 'customer_name', v_customer_name,
      'customer_phone', v_customer_phone, 'customer_phone_alt', v_customer_phone_alt,
      'raw_address', v_raw_address, 'quantity_ordered', p_quantity_ordered,
      'customer_price', p_customer_price, 'charged_snapshot', v_charged,
      'agent_payment_snapshot', v_agent_payment, 'assigned_agent_id', p_assigned_agent_id,
      'scheduled_date', p_scheduled_date, 'created_via', p_created_via,
      'current_status', 'pending', 'text_fingerprint', v_fingerprint,
      'items', v_items, 'items_fingerprint', v_items_fp,
      'delivery_instructions', v_delivery_instructions,
      'client_rep', v_client_rep,
      'auto_bumped_after_hours', v_bumped,
      'original_scheduled_date', case when v_bumped then v_original_date else null end
    ), null);

  return v_delivery_id;
end;
$function$;

-- bot_create_delivery: identical to tools/live-defs/bot_create_delivery.sql
-- (captured 2026-09-03) plus the same assert, placed BEFORE the duplicate
-- pre-emption and the orphan absorb. Without it, a listed number with an
-- unassigned sibling already in the app would be absorbed and handed a rider —
-- exactly the dispatch the blacklist exists to prevent.
CREATE OR REPLACE FUNCTION public.bot_create_delivery(p_client_uuid text, p_client_id uuid, p_product_catalog_id uuid, p_customer_name text, p_customer_phone text, p_raw_address text, p_quantity_ordered integer, p_customer_price numeric, p_location_id uuid DEFAULT NULL::uuid, p_scheduled_date date DEFAULT CURRENT_DATE, p_bot_raw_message text DEFAULT NULL::text, p_assigned_agent_id uuid DEFAULT NULL::uuid, p_customer_phone_alt text DEFAULT NULL::text, p_items jsonb DEFAULT NULL::jsonb, p_delivery_instructions text DEFAULT NULL::text, p_client_rep text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_bot_user_id        uuid;
  v_delivery_id        uuid;
  v_fingerprint        text := public._text_fingerprint(p_bot_raw_message);
  v_phone_norm         text := public._norm_phone(p_customer_phone);
  v_effective_agent_id uuid := p_assigned_agent_id;
  v_orphan_id          uuid;
  v_existing_id        uuid;
  v_eff_date           date := public._effective_scheduled_date(p_scheduled_date, 'bot');
  v_client_rep         text := nullif(trim(p_client_rep), '');
  v_items_fp           text := public._delivery_items_sig(coalesce(p_items, jsonb_build_array(
                          jsonb_build_object('product_catalog_id', p_product_catalog_id,
                                             'quantity_ordered', p_quantity_ordered))));  -- [Feature A]
begin
  select id into v_bot_user_id from public.users
   where email = 'bot@reda.dev' and is_active = true limit 1;
  if v_bot_user_id is null then
    select id into v_bot_user_id from public.users
     where role = 'admin' and is_active = true order by created_at limit 1;
  end if;
  if v_bot_user_id is null then raise exception 'no admin user available to act as bot'; end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_bot_user_id::text, 'role', 'authenticated')::text, true);

  -- Customer blacklist: refuse before the duplicate/orphan logic can dispatch.
  perform public._assert_customer_not_blacklisted(p_customer_phone, p_customer_phone_alt);

  -- Pre-empt same-agent dupe at intake — re-keyed to items_fingerprint.
  if v_effective_agent_id is not null and v_phone_norm is not null then
    select d.id into v_existing_id
      from public.deliveries d
      join public.delivery_status_defs sd on sd.status = d.current_status
     where d.assigned_agent_id = v_effective_agent_id
       and d.customer_phone_normalized = v_phone_norm
       and d.items_fingerprint = v_items_fp            -- [Feature A]
       and (d.scheduled_date = v_eff_date or d.current_status = 'postponed')
       and d.deleted_at is null
       and sd.category <> 'terminal'
       and (
         (v_fingerprint is not null and d.text_fingerprint is not null and d.text_fingerprint = v_fingerprint)
         or
         (public._norm_address(d.raw_address) = public._norm_address(p_raw_address))
       )
     order by d.created_at asc limit 1;

    if v_existing_id is not null then
      raise exception 'duplicate forward: agent % already has open delivery % for customer % items % on %',
        v_effective_agent_id, v_existing_id, v_phone_norm, v_items_fp, v_eff_date
        using errcode = 'P0001',
              hint = jsonb_build_object('kind','duplicate_same_agent',
                'existing_delivery_id', v_existing_id, 'agent_id', v_effective_agent_id)::text;
    end if;
  end if;

  -- Smart-reassign of unassigned orphan — re-keyed to items_fingerprint.
  if v_phone_norm is not null then
    select d.id into v_orphan_id
      from public.deliveries d
      join public.delivery_status_defs sd on sd.status = d.current_status
     where d.assigned_agent_id is null
       and d.customer_phone_normalized = v_phone_norm
       and d.items_fingerprint = v_items_fp            -- [Feature A]
       and d.scheduled_date = v_eff_date
       and d.deleted_at is null
       and sd.category <> 'terminal'
       and (
         (v_fingerprint is not null and d.text_fingerprint is not null and d.text_fingerprint = v_fingerprint)
         or
         (public._norm_address(d.raw_address) = public._norm_address(p_raw_address))
       )
     order by d.created_at asc limit 1 for update;

    if v_orphan_id is not null then
      -- Absorb the orphan: attach the agent, and backfill the rep from THIS
      -- forward only if the orphan doesn't already carry one (never overwrite an
      -- existing value). The rep may only appear on the second forward.
      update public.deliveries
         set assigned_agent_id = v_effective_agent_id,
             client_rep        = coalesce(client_rep, v_client_rep),
             updated_at        = now()
       where id = v_orphan_id;
      perform public.write_audit(
        p_actor_id := v_bot_user_id, p_entity_type := 'delivery', p_entity_id := v_orphan_id,
        p_old := jsonb_build_object('assigned_agent_id', null),
        p_new := jsonb_build_object('assigned_agent_id', v_effective_agent_id,
          'client_rep', v_client_rep,
          'triggering_bot_message', p_bot_raw_message),
        p_reason := 'bot_smart_reassign: absorbed unassigned sibling');
      return v_orphan_id;
    end if;
  end if;

  v_delivery_id := public.create_delivery(
    p_client_uuid => p_client_uuid, p_client_id => p_client_id,
    p_product_catalog_id => p_product_catalog_id, p_customer_name => p_customer_name,
    p_customer_phone => p_customer_phone, p_raw_address => p_raw_address,
    p_quantity_ordered => p_quantity_ordered, p_customer_price => p_customer_price,
    p_location_id => p_location_id, p_scheduled_date => v_eff_date,
    p_assigned_agent_id => v_effective_agent_id, p_created_via => 'bot',
    p_bot_raw_message => p_bot_raw_message, p_customer_phone_alt => p_customer_phone_alt,
    p_items => p_items, p_delivery_instructions => p_delivery_instructions,
    p_client_rep => p_client_rep
  );
  return v_delivery_id;
end;
$function$;

-- requeue_failed_inbound: identical to tools/live-defs/requeue_failed_inbound.sql
-- (captured 2026-09-03) except it now also accepts 'blocked' rows, so a message
-- refused by mistake can be re-run once the number is removed from the list.
CREATE OR REPLACE FUNCTION public.requeue_failed_inbound(p_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id    uuid;
  v_count int := 0;
begin
  if not public.is_admin_or_dispatcher() then
    raise exception 'permission denied: admin or dispatcher only' using errcode = '42501';
  end if;

  for v_id in
    select id from public.bot_inbound_messages
    where id = any(p_ids) and status in ('error', 'blocked')
  loop
    -- Reset to the pre-parse state so the idempotency guard (status='queued')
    -- lets bot-parse-message process it again.
    update public.bot_inbound_messages
       set status       = 'queued',
           error_text   = null,
           parse_result = null,
           processed_at = null,
           delivery_id  = null
     where id = v_id;

    -- Re-fire the parser, mirroring the bot_parse_on_insert trigger.
    perform net.http_post(
      url     := 'http://kong:8000/functions/v1/bot-parse-message',
      headers := jsonb_build_object(
        'Content-type',      'application/json',
        'x-internal-secret', '49a5d28607c3554a3d5bb7763e686195fddca3e04cf69717541dafc554bf26bb'
      ),
      body    := jsonb_build_object('inbound_message_id', v_id)
    );

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Grants. The box's default ACL hands EXECUTE to anon/authenticated/service_role
-- on every new function, so internal helpers must be revoked by name.
-- ---------------------------------------------------------------------------
revoke all on function public._customer_blacklist_hit(text, text) from public, anon, authenticated, service_role;
revoke all on function public._assert_customer_not_blacklisted(text, text) from public, anon, authenticated, service_role;
revoke all on function public.add_customer_blacklist(text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.remove_customer_blacklist(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.check_customer_blacklist(text, text) from public, anon, authenticated, service_role;
revoke all on function public.list_customer_blacklist(boolean) from public, anon, authenticated, service_role;
grant execute on function public.add_customer_blacklist(text, text, uuid) to authenticated;
grant execute on function public.remove_customer_blacklist(uuid, text) to authenticated;
grant execute on function public.check_customer_blacklist(text, text) to authenticated;
grant execute on function public.list_customer_blacklist(boolean) to authenticated;

notify pgrst, 'reload schema';
commit;

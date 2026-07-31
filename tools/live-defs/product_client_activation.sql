-- Captured live definitions (self-hosted box, 2026-07-31) — READ ONLY REFERENCE.
--
-- Why this file exists: none of these four functions had a copy anywhere in
-- the repo. They were authored directly against the database, so the only
-- record of what they actually do was the database itself. Anything that
-- rewrites them (see scripts/product-deactivation-guard.sql) must be written
-- as a diff against THIS text, never from memory.
--
-- Note the shape they all share and the gap it leaves: each one checks admin,
-- requires a reason, flips is_active, writes audit. None of them looks at what
-- is still attached to the row being retired. deactivate_client additionally
-- bulk-flips its products, bypassing deactivate_product entirely.
--
-- Signatures at capture time (exactly one overload each):
--   deactivate_product  (p_id uuid, p_reason text)
--   reactivate_product  (p_id uuid)
--   deactivate_client   (p_id uuid, p_reason text)
--   reactivate_client   (p_id uuid)

CREATE OR REPLACE FUNCTION public.deactivate_client(p_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_was_active boolean;
begin
  if not public.is_admin() then
    raise exception 'permission denied: admin only' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'reason required for deactivation' using errcode = '23514';
  end if;

  select is_active into v_was_active from public.clients where id = p_id;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  if not v_was_active then return; end if;

  update public.clients set is_active = false where id = p_id;

  -- Cascade: deactivate the client's products too (per PRD §5.3).
  update public.product_catalog set is_active = false where client_id = p_id and is_active = true;

  perform public.write_audit(
    'client', p_id,
    jsonb_build_object('is_active', true),
    jsonb_build_object('is_active', false),
    p_reason
  );
end;
$function$

CREATE OR REPLACE FUNCTION public.deactivate_product(p_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_was_active boolean;
begin
  if not public.is_admin() then
    raise exception 'permission denied: admin only' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'reason required for deactivation' using errcode = '23514';
  end if;

  select is_active into v_was_active from public.product_catalog where id = p_id;
  if not found then
    raise exception 'product not found' using errcode = 'P0002';
  end if;
  if not v_was_active then return; end if;

  update public.product_catalog set is_active = false where id = p_id;

  perform public.write_audit(
    'product', p_id,
    jsonb_build_object('is_active', true),
    jsonb_build_object('is_active', false),
    p_reason
  );
end;
$function$

CREATE OR REPLACE FUNCTION public.reactivate_client(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_was_inactive boolean;
begin
  if not public.is_admin() then
    raise exception 'permission denied: admin only' using errcode = '42501';
  end if;

  select not is_active into v_was_inactive from public.clients where id = p_id;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  if not v_was_inactive then return; end if;

  update public.clients set is_active = true where id = p_id;

  perform public.write_audit(
    'client', p_id,
    jsonb_build_object('is_active', false),
    jsonb_build_object('is_active', true)
  );
end;
$function$

CREATE OR REPLACE FUNCTION public.reactivate_product(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_was_inactive   boolean;
  v_client_active  boolean;
  v_client_id      uuid;
begin
  if not public.is_admin() then
    raise exception 'permission denied: admin only' using errcode = '42501';
  end if;

  select not is_active, client_id into v_was_inactive, v_client_id from public.product_catalog where id = p_id;
  if not found then
    raise exception 'product not found' using errcode = 'P0002';
  end if;
  if not v_was_inactive then return; end if;

  select is_active into v_client_active from public.clients where id = v_client_id;
  if not v_client_active then
    raise exception 'cannot reactivate: parent client is inactive' using errcode = '23514';
  end if;

  update public.product_catalog set is_active = true where id = p_id;

  perform public.write_audit(
    'product', p_id,
    jsonb_build_object('is_active', false),
    jsonb_build_object('is_active', true)
  );
end;
$function$


\set ON_ERROR_STOP on

-- Installed-definition checks.
do $definitions$
begin
  if pg_get_functiondef('public.tg_handle_sibling_coordination()'::regprocedure)
     not like '%postpone_sibling_consolidated%'
  then
    raise exception 'immediate postponement consolidation is missing';
  end if;

  if pg_get_functiondef('public.release_postponed_due(date)'::regprocedure)
     not like '%postponed_release_duplicate_consolidated%'
  then
    raise exception 'release-time postponement deduplication is missing';
  end if;

  if not exists (
    select 1
      from pg_trigger
     where tgrelid = 'public.deliveries'::regclass
       and tgname = 'handle_sibling_coordination'
       and not tgisinternal
       and pg_get_triggerdef(oid) like '%UPDATE OF current_status, scheduled_date%'
  ) then
    raise exception 'status/date sibling coordination trigger is missing';
  end if;
end
$definitions$;

select 'PASS: installed definitions and trigger are current' as definitions;

-- No active due/future postponed-origin sibling group should contain more than
-- one row after cleanup. This is read-only and safe to run in production.
with active as (
  select d.id, d.client_id, d.customer_phone_normalized,
         coalesce(d.items_fingerprint, d.product_catalog_id::text) as item_key,
         d.scheduled_date, d.text_fingerprint,
         public._norm_address(d.raw_address) as norm_addr
    from public.deliveries d
    join public.delivery_status_defs sd on sd.status = d.current_status
   where d.deleted_at is null
     and sd.category <> 'terminal'
     and d.scheduled_date >= (now() at time zone 'Africa/Lagos')::date
     and (d.current_status = 'postponed' or d.rolled_from_status = 'postponed')
), duplicate_pairs as (
  select 1
    from active a
    join active b
      on b.client_id = a.client_id
     and b.customer_phone_normalized = a.customer_phone_normalized
     and b.item_key = a.item_key
     and b.scheduled_date = a.scheduled_date
     and b.id > a.id
     and (
       (a.text_fingerprint is not null and a.text_fingerprint = b.text_fingerprint)
       or (a.norm_addr is not null and a.norm_addr = b.norm_addr)
     )
)
select case
  when count(*) = 0 then 'PASS: no active postponed sibling duplicates'
  else 'FAIL: ' || count(*)::text || ' active postponed sibling pair(s) remain'
end as live_duplicates
from duplicate_pairs;

do $duplicates$
begin
  if exists (
    with active as (
      select d.id, d.client_id, d.customer_phone_normalized,
             coalesce(d.items_fingerprint, d.product_catalog_id::text) as item_key,
             d.scheduled_date, d.text_fingerprint,
             public._norm_address(d.raw_address) as norm_addr
        from public.deliveries d
        join public.delivery_status_defs sd on sd.status = d.current_status
       where d.deleted_at is null
         and sd.category <> 'terminal'
         and d.scheduled_date >= (now() at time zone 'Africa/Lagos')::date
         and (d.current_status = 'postponed' or d.rolled_from_status = 'postponed')
    )
    select 1
      from active a
      join active b
        on b.client_id = a.client_id
       and b.customer_phone_normalized = a.customer_phone_normalized
       and b.item_key = a.item_key
       and b.scheduled_date = a.scheduled_date
       and b.id > a.id
       and (
         (a.text_fingerprint is not null and a.text_fingerprint = b.text_fingerprint)
         or (a.norm_addr is not null and a.norm_addr = b.norm_addr)
       )
  ) then
    raise exception 'active postponed sibling duplicates remain';
  end if;
end
$duplicates$;

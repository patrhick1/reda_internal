-- Stock counts — a physical-count log for reconciliation. Ops (admin/dispatcher)
-- count a holder's shelf or a rider's bag; the app records what they counted vs
-- what it expected (current_stock at that moment) and the variance. It is a
-- REPORT: it never writes to the stock ledger and never changes current_stock.
-- If a variance can't be explained, correcting it stays a separate, deliberate
-- action via the existing admin `correction` adjustment — not this feature.
--
-- Each count row is a durable reference point: `expected_qty` freezes what the
-- app said at count time, so a later trace ("since my last count …") is bounded.

create table if not exists public.stock_counts (
  id                 uuid primary key default gen_random_uuid(),
  batch_id           uuid not null,                              -- one count run (a holder counted at one sitting)
  holder_id          uuid not null references public.users(id),  -- warehouse place or a rider
  product_catalog_id uuid not null references public.product_catalog(id),
  expected_qty       int  not null,                              -- current_stock at count time (the app's number)
  counted_qty        int  not null,                              -- physical count
  variance           int  not null,                              -- counted - expected (0 = matches)
  counted_by         uuid references public.users(id),
  counted_at         timestamptz not null default now(),
  note               text,
  unique (batch_id, product_catalog_id)                          -- idempotent within a run
);

create index if not exists idx_stock_counts_holder_product
  on public.stock_counts (holder_id, product_catalog_id, counted_at desc);   -- "last count" lookup
create index if not exists idx_stock_counts_batch on public.stock_counts (batch_id);

alter table public.stock_counts enable row level security;

-- Reads: ops (admin/dispatcher/rep via is_admin_or_dispatcher) + warehouse —
-- mirrors canViewOthersStockHistory. Writes only via record_stock_count().
drop policy if exists stock_counts_select on public.stock_counts;
create policy stock_counts_select on public.stock_counts
  for select
  using (public.is_admin_or_dispatcher() or public.is_warehouse());

revoke all on public.stock_counts from anon, authenticated;
grant select on public.stock_counts to authenticated;

-- ---------------------------------------------------------------------------
-- record_stock_count — log a count run. REPORT-ONLY: reads current_stock for the
-- expected qty and stores counted/variance; it does NOT create any
-- stock_adjustments and does NOT change current_stock.
--   p_items: jsonb array of {"product_catalog_id": uuid, "counted_qty": int}
-- Permission: admin/dispatcher may count any holder; warehouse only its own place.
-- Idempotent on (batch_id, product): re-submitting a run records no duplicates.
-- ---------------------------------------------------------------------------
create or replace function public.record_stock_count(
  p_batch_id  uuid,
  p_holder_id uuid,
  p_items     jsonb,
  p_note      text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'auth'
as $fn$
declare
  v_actor        uuid := auth.uid();
  v_role         text;
  v_warehouse_id uuid;
  v_item         jsonb;
  v_pid          uuid;
  v_counted      int;
  v_expected     int;
  v_recorded     int := 0;
  v_matched      int := 0;
  v_off          int := 0;
begin
  if v_actor is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  select role, warehouse_id into v_role, v_warehouse_id from public.users where id = v_actor;

  -- Permission gate. A count never mutates stock, so this is intentionally
  -- broader than the adjustment gate — but warehouse is still scoped to its place.
  if v_role in ('admin', 'dispatcher') then
    null;
  elsif v_role = 'warehouse' and p_holder_id = coalesce(v_warehouse_id, v_actor) then
    null;
  else
    raise exception 'permission denied: cannot record a count for this holder'
      using errcode = '42501',
            hint    = 'admin/dispatcher can count any holder; warehouse can count only its own place.';
  end if;

  if p_batch_id is null then
    raise exception 'batch_id required' using errcode = '23514';
  end if;
  if not exists (select 1 from public.users where id = p_holder_id) then
    raise exception 'holder not found' using errcode = '23514';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'items must be a json array' using errcode = '23514';
  end if;

  for v_item in select jsonb_array_elements(p_items) loop
    v_pid     := nullif(v_item->>'product_catalog_id', '')::uuid;
    v_counted := (v_item->>'counted_qty')::int;
    if v_pid is null or v_counted is null then
      continue;
    end if;
    if not exists (select 1 from public.product_catalog where id = v_pid) then
      continue;
    end if;
    -- Idempotency: this (batch, product) already recorded → skip.
    if exists (
      select 1 from public.stock_counts where batch_id = p_batch_id and product_catalog_id = v_pid
    ) then
      continue;
    end if;

    select coalesce(quantity_on_hand, 0) into v_expected
      from public.current_stock
     where agent_id = p_holder_id and product_catalog_id = v_pid;
    v_expected := coalesce(v_expected, 0);

    insert into public.stock_counts (
      batch_id, holder_id, product_catalog_id, expected_qty, counted_qty, variance, counted_by, note
    ) values (
      p_batch_id, p_holder_id, v_pid, v_expected, v_counted, v_counted - v_expected, v_actor, p_note
    );

    v_recorded := v_recorded + 1;
    if v_counted = v_expected then
      v_matched := v_matched + 1;
    else
      v_off := v_off + 1;
    end if;
  end loop;

  perform public.write_audit(
    'stock_count', p_batch_id, null,
    jsonb_build_object(
      'holder_id', p_holder_id, 'recorded', v_recorded,
      'matched', v_matched, 'off', v_off, 'note', p_note
    ),
    'record stock count', v_actor
  );

  return jsonb_build_object('recorded', v_recorded, 'matched', v_matched, 'off', v_off);
end;
$fn$;

revoke all on function public.record_stock_count(uuid, uuid, jsonb, text) from public;
grant execute on function public.record_stock_count(uuid, uuid, jsonb, text) to authenticated;

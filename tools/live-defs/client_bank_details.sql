-- Client (vendor) bank details for the Moniepoint bulk-payout CSV (2026-06-23).
--
-- Adds three nullable columns to `clients` and a dedicated, admin-only setter
-- RPC. Kept SEPARATE from the (overloaded) update_client so we don't drop/replace
-- a shared production function — this is purely additive.
--
-- The CSV upload needs: Account Name, Account Number, Bank (a valid Moniepoint
-- bank name). We store the canonical bank name the app picks from
-- mobile/src/lib/moniepoint-banks.ts.

begin;

alter table public.clients
  add column if not exists bank_account_name   text,
  add column if not exists bank_account_number text,
  add column if not exists bank_name           text;

create or replace function public.set_client_bank_details(
  p_id                  uuid,
  p_bank_account_name   text,
  p_bank_account_number text,
  p_bank_name           text,
  p_reason              text default null
) returns void
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
declare
  v_old       public.clients;
  v_acct_name text := nullif(trim(p_bank_account_name), '');
  v_acct_no   text := nullif(trim(p_bank_account_number), '');
  v_bank      text := nullif(trim(p_bank_name), '');
begin
  if not public.is_admin() then
    raise exception 'permission denied: admin only' using errcode = '42501';
  end if;
  select * into v_old from public.clients where id = p_id;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  -- Nigerian NUBAN is 10 digits. Validate only when provided so the field stays
  -- optional; a bad number would otherwise silently fail the Moniepoint upload.
  if v_acct_no is not null and v_acct_no !~ '^[0-9]{10}$' then
    raise exception 'bank account number must be exactly 10 digits' using errcode = '23514';
  end if;

  -- Sets (not coalesces) all three: the edit form always submits the full set
  -- pre-filled with current values, so clearing a field intentionally nulls it.
  update public.clients
     set bank_account_name   = v_acct_name,
         bank_account_number = v_acct_no,
         bank_name           = v_bank
   where id = p_id;

  perform public.write_audit(
    'client', p_id,
    jsonb_build_object(
      'bank_account_name',   v_old.bank_account_name,
      'bank_account_number', v_old.bank_account_number,
      'bank_name',           v_old.bank_name
    ),
    jsonb_build_object(
      'bank_account_name',   v_acct_name,
      'bank_account_number', v_acct_no,
      'bank_name',           v_bank
    ),
    p_reason
  );
end;
$function$;

grant execute on function public.set_client_bank_details(uuid, text, text, text, text) to authenticated;

commit;

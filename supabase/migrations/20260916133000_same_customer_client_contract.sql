-- Install disabled: enforcing this contract follows the pay activation boundary.
-- PostgREST must be configured with db-pre-request=public.check_payment_client_contract.
-- A client header is a compatibility declaration, never authorization; RLS and
-- the financial RPC role/settlement checks remain authoritative.
begin;
create or replace function public.check_payment_client_contract()
returns void language plpgsql stable security definer set search_path=public,auth as $$
declare v_headers jsonb; v_path text:=current_setting('request.path',true);
begin
  -- Trusted server integrations retain their own authorization and pay guards.
  if auth.role() is distinct from 'authenticated' then return; end if;
  -- Keep profile loading available so old native builds can show the updater.
  -- No delivery or financial data is returned by this narrow exception.
  if v_path='/users' and current_setting('request.method',true) in ('GET','HEAD') then return; end if;
  if not exists(select 1 from public.same_customer_pay_policy
      where active_from<=(now() at time zone 'Africa/Lagos')::date)
    and not exists(select 1 from public.same_customer_pay_policy_days where enabled) then return; end if;
  v_headers:=coalesce(nullif(current_setting('request.headers',true),'')::jsonb,'{}'::jsonb);
  if v_headers->>'x-reda-payment-contract' is distinct from '1' then
    raise sqlstate 'PT426' using message='Update REDA before continuing. Rider payment rules have changed.',
      detail='Refresh the web page, or restart the mobile app after its update downloads. Unsynced orders remain on your device.',
      hint='Payment client contract 1 is required.';
  end if;
end $$;
revoke all on function public.check_payment_client_contract() from public,anon;
grant execute on function public.check_payment_client_contract() to anon,authenticated,service_role;
commit;

-- Automatically enable the client balance ledger for every client.
--
-- August 24, 2026 is the cutover requested for the existing client book. Any
-- opening that an admin already configured is preserved. New clients start with
-- a clear balance on their creation date.

begin;

alter table public.client_balance_openings
  alter column set_by drop not null;

insert into public.client_balance_openings(
  client_id, effective_date, opening_balance, note, setup_request_uuid, set_by
)
select
  c.id,
  greatest(
    date '2026-08-24',
    (coalesce(c.created_at, now()) at time zone 'Africa/Lagos')::date
  ),
  0,
  'Automatically enabled at the client balance ledger cutover',
  'auto:' || c.id::text,
  null
from public.clients c
on conflict (client_id) do nothing;

create or replace function public.tg_auto_initialize_client_balance()
returns trigger
language plpgsql security definer set search_path = 'public', 'auth'
as $function$
begin
  insert into public.client_balance_openings(
    client_id, effective_date, opening_balance, note, setup_request_uuid, set_by
  ) values (
    new.id,
    greatest(
      date '2026-08-24',
      (coalesce(new.created_at, now()) at time zone 'Africa/Lagos')::date
    ),
    0,
    'Automatically enabled when the client was created',
    'auto:' || new.id::text,
    null
  )
  on conflict (client_id) do nothing;
  return new;
end;
$function$;

drop trigger if exists clients_auto_initialize_balance on public.clients;
create trigger clients_auto_initialize_balance
after insert on public.clients
for each row execute function public.tg_auto_initialize_client_balance();

notify pgrst, 'reload schema';

commit;

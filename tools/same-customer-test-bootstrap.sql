-- Only for the dedicated localhost schema-only test clone. No production data.
do $$ begin
  if current_database() <> 'reda_same_customer_test' then
    raise exception 'Refusing to bootstrap outside reda_same_customer_test';
  end if;
end $$;
create role authenticated nologin;
create role anon nologin;
create role service_role nologin;
create schema extensions;
create extension pgcrypto with schema extensions;
create extension pg_trgm;
-- The clone has no outbound network extension. Functions which send notifications
-- are replaced with local no-ops after restore, and cannot contact real riders.
create schema net;
create table net._http_response (
  id bigint, status_code integer, content text, created timestamptz default now()
);
create schema supabase_functions;
create function supabase_functions.http_request() returns trigger
language plpgsql as $$ begin return new; end $$;

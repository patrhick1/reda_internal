-- Restrict relationship discovery without changing general rep permissions or pay.
begin;
do $migration$
declare target regprocedure; definition text;
begin
  foreach target in array array[
    'public.list_same_customer_orders(date,text,integer,uuid,uuid,text)'::regprocedure,
    'public.get_same_customer_orders(date,text)'::regprocedure,
    'public.same_customer_badges(uuid[])'::regprocedure
  ] loop
    definition:=pg_get_functiondef(target);
    if strpos(definition,'if not public.is_admin_or_dispatcher() then')>0 then
      definition:=replace(definition,'if not public.is_admin_or_dispatcher() then','if not public.is_manager() then');
      definition:=replace(definition,'operations role required','admin or dispatcher role required');
      execute definition;
    elsif strpos(definition,'if not public.is_manager() then')=0 then
      raise exception 'Unexpected discovery permission guard: %',target;
    end if;
  end loop;
  target:='public.get_same_customer_config()'::regprocedure;
  definition:=pg_get_functiondef(target);
  if strpos(definition,'public.is_manager() and coalesce')=0 then
    if strpos(definition,'coalesce((select enabled from public.feature_flags where key=''same_customer_discovery''),false)')=0 then
      raise exception 'Unexpected discovery configuration';
    end if;
    definition:=replace(definition,
      'coalesce((select enabled from public.feature_flags where key=''same_customer_discovery''),false)',
      '(public.is_manager() and coalesce((select enabled from public.feature_flags where key=''same_customer_discovery''),false))');
    execute definition;
  end if;
end $migration$;
notify pgrst,'reload schema';
commit;

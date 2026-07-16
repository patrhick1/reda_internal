-- Agents may raise every established standalone delivery flag except
-- no_product. Inventory availability is an ops decision. Customer-contact
-- outcomes that pass through this RPC from the status workflow remain valid.
-- Existing historical delivery_messages rows and their issue_type constraint
-- remain untouched.

begin;

create or replace function public.flag_delivery_issue(
  p_delivery_id uuid, p_issue_type text, p_note text, p_new_status text, p_client_uuid uuid
) returns public.delivery_messages
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
declare
  v_user     uuid := auth.uid();
  v_status   text;
  v_agent    uuid;
  v_existing public.delivery_messages%rowtype;
  v_new      public.delivery_messages%rowtype;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if p_client_uuid is null then
    raise exception 'p_client_uuid is required' using errcode = '22023';
  end if;

  if p_issue_type is null or p_issue_type not in (
    'wrong_address','cant_reach_client','payment_dispute',
    'product_issue','not_my_route','other'
  ) then
    raise exception 'invalid issue_type: %', coalesce(p_issue_type, 'null')
      using errcode = '22023';
  end if;

  -- Idempotency: if this client_uuid already produced a message, return it.
  select * into v_existing
    from public.delivery_messages
   where client_uuid = p_client_uuid;
  if found then
    return v_existing;
  end if;

  select current_status, assigned_agent_id
    into v_status, v_agent
    from public.deliveries
   where id = p_delivery_id;
  if v_status is null then
    raise exception 'delivery not found' using errcode = 'P0002';
  end if;
  if v_agent is null or v_agent <> v_user then
    raise exception 'only the assigned agent can flag this delivery'
      using errcode = '42501';
  end if;
  if public._dm_is_terminal_status(v_status) then
    raise exception 'cannot flag a terminal delivery (status %)', v_status
      using errcode = '22023';
  end if;

  if p_new_status is not null then
    perform public.change_delivery_status(
      p_client_uuid => p_client_uuid::text,
      p_delivery_id => p_delivery_id,
      p_to_status   => p_new_status,
      p_reason      => p_issue_type,
      p_notes       => p_note
    );
  end if;

  insert into public.delivery_messages (
    delivery_id, author_id, author_role, issue_type, note, client_uuid
  ) values (
    p_delivery_id, v_user, 'agent', p_issue_type,
    nullif(trim(coalesce(p_note,'')), ''), p_client_uuid
  ) returning * into v_new;

  perform public.write_audit(
    'delivery_message', v_new.id,
    null,
    jsonb_build_object(
      'issue_type', p_issue_type, 'note', p_note, 'new_status', p_new_status
    ),
    'flag', null
  );

  return v_new;
end $function$;

commit;

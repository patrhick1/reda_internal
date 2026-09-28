begin;
do $$
declare s jsonb; seen bigint; n int;
begin
  perform set_config('request.jwt.claim.sub',md5('admin')::uuid::text,true);
  assert (public.get_blacklist_notice_summary()->>'count')::int=0,'no historical flood';
  insert into public.bot_inbound_messages values(md5('one')::uuid,'queued',
    '{"extracted":{"customer_name":"Test Customer"},"product":{"client_name":"Test Vendor"}}');
  update public.bot_inbound_messages set status='blocked' where id=md5('one')::uuid;
  s:=public.get_blacklist_notice_summary();
  assert (s->>'count')::int=1,'refusal recorded';
  seen:=(s->>'through_id')::bigint;
  assert (s->>'inbound_id')::uuid=md5('one')::uuid,'correct deep link';
  assert (select count(*) from public.test_pushes)=1,'one push';
  assert (select payload->'data'->>'tab'='blocked' and payload->>'audience'='admins+dispatchers'
    and payload->>'body' like '%Test Customer%Test Vendor%' from public.test_pushes),'push context';
  update public.bot_inbound_messages set status='blocked' where id=md5('one')::uuid;
  update public.bot_inbound_messages set status='queued' where id=md5('one')::uuid;
  update public.bot_inbound_messages set status='blocked' where id=md5('one')::uuid;
  assert (select count(*) from public.blacklist_order_notices)=1,'retries deduplicated';
  insert into public.bot_inbound_messages values(md5('two')::uuid,'blocked','{}');
  assert (public.get_blacklist_notice_summary()->>'count')::int=2,'all blocked events retained';
  assert (select count(*) from public.test_pushes)=1,'burst is quiet';
  perform public.acknowledge_blacklist_notices(seen);
  assert (public.get_blacklist_notice_summary()->>'count')::int=1,'new arrivals survive acknowledgment';
  perform public.acknowledge_blacklist_notices(0);
  assert (public.get_blacklist_notice_summary()->>'count')::int=1,'stale device cannot undo seen state';
  perform set_config('request.jwt.claim.sub',md5('rep')::uuid::text,true);
  assert (public.get_blacklist_notice_summary()->>'count')::int=2,'seen state is per user';
  perform set_config('request.jwt.claim.sub',md5('dispatcher')::uuid::text,true);
  assert (public.get_blacklist_notice_summary()->>'count')::int=2,'dispatcher can read';
  update public.bot_inbound_messages set status='created_delivery' where id=md5('one')::uuid;
  assert (public.get_blacklist_notice_summary()->>'count')::int=1,'resolved refusal leaves unread summary';
  update public.blacklist_notice_push_state set last_sent_at=clock_timestamp()-interval '11 minutes';
  insert into public.bot_inbound_messages values(md5('three')::uuid,'blocked','{}');
  assert (select count(*) from public.test_pushes)=2,'cooldown permits later notice';
  perform public.acknowledge_blacklist_notices(9223372036854775807);
  insert into public.bot_inbound_messages values(md5('four')::uuid,'blocked','{}');
  assert (public.get_blacklist_notice_summary()->>'count')::int=1,'cannot acknowledge future notices';
  update public.blacklist_notice_push_state set last_sent_at=null;
  perform set_config('test.fail_push','yes',true);
  insert into public.bot_inbound_messages values(md5('five')::uuid,'blocked','{}');
  assert (public.get_blacklist_notice_summary()->>'count')::int=2,'transport failure preserves durable notice';
  assert (select status from public.bot_inbound_messages where id=md5('five')::uuid)='blocked','transport failure preserves refusal';
  assert not has_table_privilege('authenticated','public.blacklist_notice_reads','UPDATE'),'no direct read-marker writes';
  assert not has_table_privilege('authenticated','public.blacklist_order_notices','SELECT'),'no direct notice exposure';
  assert not has_function_privilege('anon','public.get_blacklist_notice_summary()','EXECUTE'),'anon denied';
  foreach s in array array[to_jsonb('agent'::text),to_jsonb('inactive'::text),to_jsonb('missing'::text)] loop
    perform set_config('request.jwt.claim.sub',md5(s#>>'{}')::uuid::text,true);
    begin
      perform public.get_blacklist_notice_summary();
      raise exception 'unauthorized summary allowed';
    exception when insufficient_privilege then null; end;
    begin
      perform public.acknowledge_blacklist_notices(1);
      raise exception 'unauthorized acknowledgment allowed';
    exception when insufficient_privilege then null; end;
  end loop;
end $$;
rollback;

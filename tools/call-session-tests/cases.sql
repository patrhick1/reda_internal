begin;
create function pg_temp.check_ok(condition boolean,label text) returns void language plpgsql as $$
begin if condition is distinct from true then raise exception 'FAIL: %',label; end if; raise notice 'PASS: %',label; end $$;
select set_config('request.jwt.claim.sub',md5('caller')::uuid::text,true);
do $$
declare first_call public.calls; retry public.calls; active public.calls; newer public.calls;
begin
  first_call:=public.initiate_call(md5('callee')::uuid,md5('device')::uuid,null,gen_random_uuid());
  retry:=public.initiate_call(md5('callee')::uuid,md5('device')::uuid,null,gen_random_uuid());
  perform pg_temp.check_ok(first_call.id=retry.id,'repeat tap returns original call');
  perform pg_temp.check_ok((select count(*)=1 from public.calls),'one call and one ring');
  perform pg_temp.check_ok((select count(*)=1 from public.call_test_audit),'resume does not duplicate initiation audit');
  active:=public.get_my_active_call(md5('device')::uuid);
  perform pg_temp.check_ok(active.id=first_call.id,'cold start finds own ringing call');
  active:=public.get_my_active_call(md5('other-device')::uuid);
  perform pg_temp.check_ok(active.id is null,'another device cannot recover this call');
  begin
    perform public.initiate_call(md5('callee')::uuid,md5('other-device')::uuid,null,gen_random_uuid());
    raise exception 'FAIL: another device stole the call';
  exception when sqlstate '55000' then null; end;
  perform set_config('request.jwt.claim.sub',md5('other')::uuid::text,true);
  begin
    perform public.initiate_call(md5('callee')::uuid,md5('other-device')::uuid,null,gen_random_uuid());
    raise exception 'FAIL: busy callee accepted second ring';
  exception when sqlstate '55000' then null; end;
  perform set_config('request.jwt.claim.sub',md5('caller')::uuid::text,true);
  update public.calls set ringing_until=now()-interval '1 second' where id=first_call.id;
  newer:=public.initiate_call(md5('callee')::uuid,md5('device')::uuid,null,gen_random_uuid());
  perform pg_temp.check_ok(newer.id<>first_call.id,'expired ring does not block immediate retry');
  perform pg_temp.check_ok((select status='missed' from public.calls where id=first_call.id),'old ring cleared without cron');

  perform set_config('request.jwt.claim.sub',md5('callee')::uuid::text,true);
  newer:=public.accept_call(newer.id,md5('callee-device')::uuid);
  active:=public.get_my_active_call(md5('callee-device')::uuid);
  perform pg_temp.check_ok(active.id=newer.id and active.status='accepted','callee restores accepted call');
  active:=public.accept_call(newer.id,md5('callee-device')::uuid);
  perform pg_temp.check_ok(active.id=newer.id,'accept retry is idempotent on the same device');
  begin
    perform public.accept_call(newer.id,md5('wrong-device')::uuid);
    raise exception 'FAIL: accepted call stolen on another device';
  exception when sqlstate '55000' then null; end;
  perform set_config('request.jwt.claim.sub',md5('caller')::uuid::text,true);
  retry:=public.initiate_call(md5('callee')::uuid,md5('device')::uuid,null,gen_random_uuid());
  perform pg_temp.check_ok(retry.id=newer.id and retry.status='accepted','repeat tap reopens accepted call');
  perform set_config('request.jwt.claim.sub',md5('other')::uuid::text,true);
  begin
    perform public.initiate_call(md5('callee')::uuid,md5('other-device')::uuid,null,gen_random_uuid());
    raise exception 'FAIL: accepted callee allowed another caller';
  exception when sqlstate '55000' then null; end;

  update public.calls set status='completed',ended_at=now() where id=newer.id;
  perform set_config('request.jwt.claim.sub',md5('caller')::uuid::text,true);
  first_call:=public.initiate_call(md5('callee')::uuid,md5('device')::uuid,null,gen_random_uuid());
  update public.calls set ringing_until=now()-interval '1 second' where id=first_call.id;
  perform set_config('request.jwt.claim.sub',md5('callee')::uuid::text,true);
  begin
    perform public.accept_call(first_call.id,md5('callee-device')::uuid);
    raise exception 'FAIL: expired call accepted';
  exception when sqlstate '55000' then null; end;
  perform set_config('request.jwt.claim.sub',md5('caller')::uuid::text,true);
  active:=public.get_my_active_call(md5('device')::uuid);
  perform pg_temp.check_ok(active.id is null,'recovery clears expired call instead of rejoining');
  perform pg_temp.check_ok((select status='missed' from public.calls where id=first_call.id),'recovery records missed call');
end $$;

do $$ declare c public.calls; begin
  perform set_config('request.jwt.claim.sub',md5('callee')::uuid::text,true);
  c:=public.initiate_call(null,md5('callee-device')::uuid,null,gen_random_uuid(),'ops_team');
  perform set_config('request.jwt.claim.sub',md5('other')::uuid::text,true);
  c:=public.accept_call(c.id,md5('other-device')::uuid);
  perform pg_temp.check_ok(c.status='accepted' and c.callee_id=md5('other')::uuid,'team call accepts and is recoverable');
  perform set_config('request.jwt.claim.sub',md5('caller')::uuid::text,true);
  begin perform public.accept_call(c.id,md5('device')::uuid); raise exception 'FAIL: losing team recipient took call';
    exception when sqlstate '55000' then null; end;
end $$;

do $$ begin
  perform set_config('request.jwt.claim.sub','',true);
  begin perform public.get_my_active_call(md5('device')::uuid); raise exception 'FAIL: anonymous recovery';
    exception when sqlstate '28000' then null; end;
  perform set_config('request.jwt.claim.sub',md5('inactive')::uuid::text,true);
  begin perform public.get_my_active_call(md5('device')::uuid); raise exception 'FAIL: inactive recovery';
    exception when sqlstate '42501' then null; end;
  perform pg_temp.check_ok(not has_function_privilege('anon','public.get_my_active_call(uuid)','execute'),'anonymous RPC access revoked');
end $$;
rollback;

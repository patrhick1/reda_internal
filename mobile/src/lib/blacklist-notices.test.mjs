import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blacklistCreationError, blockedOrdersRoute } from './blacklist-notices.ts';
import { notificationPresentation } from '../../../supabase/functions/_shared/notification-policy.ts';

test('manual refusal explains no order was created and retains actionable context',()=>{
  const message=blacklistCreationError({code:'P0001',hint:JSON.stringify({kind:'blacklisted',phone:'08030000001',reason:'Repeated failed deliveries'})});
  assert.match(message,/Order not created/);
  assert.match(message,/08030000001/);
  assert.match(message,/Repeated failed deliveries/);
  assert.match(message,/details are still here/);
});
test('unrelated failures are not misrepresented as blacklist refusals',()=>{
  for(const value of [null,new Error('offline'),{code:'42501',hint:'{"kind":"blacklisted"}'},{code:'P0001',hint:'bad json'},{code:'P0001',hint:'{"kind":"duplicate_same_agent"}'}]) assert.equal(blacklistCreationError(value),null);
});
test('missing blacklist details still yield a clear refusal',()=>{
  assert.match(blacklistCreationError({code:'P0001',hint:'{"kind":"blacklisted"}'}),/number is blacklisted/);
});
test('all ops roles open Blocked and preserve the specific inbound id',()=>{
  const id='11111111-1111-4111-8111-111111111111';
  for(const role of ['admin','dispatcher','rep']) assert.match(blockedOrdersRoute(role,id),new RegExp(`tab=blocked&inboundId=${id}$`));
  assert.equal(blockedOrdersRoute('agent',id),null);
  assert.equal(blockedOrdersRoute('warehouse',id),null);
  assert.equal(blockedOrdersRoute('admin','bad&tab=all'),'/(admin)/needs-review?tab=blocked');
});
test('blacklist pushes use a quiet channel and replace the previous tray notice',()=>{
  assert.deepEqual(notificationPresentation({kind:'blacklist_blocked'}),{sound:null,priority:'normal',channelId:'blocked-orders',tag:'blocked-orders'});
});
test('call and delivery notification presentation remains urgent',()=>{
  for(const data of [undefined,{route:'call_invite'},{route:'deliveries'}]) assert.deepEqual(notificationPresentation(data),{sound:'default',priority:'high',channelId:'default'});
});

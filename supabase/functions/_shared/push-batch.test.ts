import { submitPushBatch } from './push-batch.ts';

Deno.test('provider HTTP/network/invalid-ticket failures remain retryable', async () => {
  for (const response of [new Response('unavailable', { status: 503 }), new Response('{}'), new Response('invalid json')]) {
    const result = await submitPushBatch([{ to: 'isolated-token' }], (() => Promise.resolve(response)) as typeof fetch);
    if (result.failed !== 1 || result.accepted !== 0) throw new Error('Provider failure was treated as success');
  }
  const result = await submitPushBatch([{ to: 'isolated-token' }], (() => Promise.reject(new Error('offline'))) as typeof fetch);
  if (result.failed !== 1) throw new Error('Network failure lost');
});
Deno.test('mixed tickets retain retryable errors and prune only unregistered devices', async () => {
  const response = new Response(JSON.stringify({ data: [
    { status: 'ok' }, { status: 'error', details: { error: 'DeviceNotRegistered' } },
    { status: 'error', details: { error: 'MessageRateExceeded' } },
  ] }));
  const result = await submitPushBatch([{ to: 'a' }, { to: 'b' }, { to: 'c' }], (() => Promise.resolve(response)) as typeof fetch);
  if (result.accepted !== 1 || result.failed !== 1 || result.stale.join() !== 'b') throw new Error('Mixed tickets classified incorrectly');
});

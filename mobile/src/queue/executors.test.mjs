import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = ts.transpileModule(
  readFileSync(new URL('./executors.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  },
).outputText;

function harness() {
  const calls = [];
  let response = { error: null };
  const rpc = async (name, args) => {
    calls.push({ name, args });
    return response;
  };
  const exports = {};
  vm.runInNewContext(source, {
    exports,
    Date,
    Number,
    require(name) {
      if (name === '@/lib/supabase') return { supabase: { rpc }, rpcUntyped: rpc };
      if (name === '@/lib/errors') return { classifyRpcError: (error) => error };
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  return {
    execute: exports.executeJob,
    calls,
    failOnce: (error) => {
      response = { error };
    },
    succeed: () => {
      response = { error: null };
    },
  };
}

test('offline completion preserves occurrence and request identity through failed replay across Lagos midnight', async () => {
  const h = harness();
  const job = {
    kind: 'change_delivery_status',
    clientUuid: 'persisted-request',
    createdAt: Date.parse('2026-09-15T22:55:00Z'), // 23:55 in Lagos
    args: {
      deliveryId: 'delivery-a',
      toStatus: 'delivered',
      paid: 10000,
      quantityDelivered: 1,
      paymentMethod: 'transfer',
    },
    attempts: 0,
    nextAttemptAt: Date.parse('2026-09-15T23:05:00Z'),
  };
  h.failOnce(new Error('temporary network failure'));
  await assert.rejects(h.execute(job), /temporary network failure/);
  h.succeed();
  await h.execute({ ...job, attempts: 1, nextAttemptAt: Date.parse('2026-09-16T06:00:00Z') });
  assert.equal(h.calls.length, 2);
  for (const { name, args } of h.calls) {
    assert.equal(name, 'change_delivery_status');
    assert.equal(args.p_effective_at, '2026-09-15T22:55:00.000Z');
    assert.equal(args.p_client_uuid, 'persisted-request');
    assert.equal(args.p_paid, 10000);
  }
});

test('malformed legacy timestamp falls back to server handling without inventing an occurrence', async () => {
  const h = harness();
  await h.execute({
    kind: 'change_delivery_status',
    clientUuid: 'legacy-request',
    createdAt: NaN,
    args: { deliveryId: 'delivery-a', toStatus: 'delivered' },
  });
  assert.equal(h.calls[0].args.p_effective_at, undefined);
});

test('ordinary non-completion status RPC keeps its previous date semantics', async () => {
  const h = harness();
  await h.execute({
    kind: 'change_delivery_status',
    clientUuid: 'pending-request',
    createdAt: Date.now(),
    args: { deliveryId: 'delivery-a', toStatus: 'pending' },
  });
  assert.equal(h.calls[0].args.p_effective_at, undefined);
});

test('offline postponement retries retain the reviewed revision, date and request ID', async () => {
  const h = harness();
  const job = {
    kind: 'change_delivery_status',
    clientUuid: 'postponement-request',
    createdAt: Date.now(),
    args: {
      deliveryId: 'order-a',
      toStatus: 'postponed',
      newScheduledDate: '2026-09-28',
      expectedUpdatedAt: '2026-09-21T12:00:00Z',
      expectedStatus: 'postponed',
      expectedScheduledDate: '2026-09-23',
    },
  };
  h.failOnce(new Error('network unavailable'));
  await assert.rejects(h.execute(job));
  h.succeed();
  await h.execute({ ...job, attempts: 1 });
  assert.deepEqual(h.calls[0], h.calls[1]);
  assert.equal(h.calls[1].name, 'postpone_delivery');
  assert.equal(h.calls[1].args.p_expected_date, '2026-09-23');
  assert.equal(h.calls[1].args.p_expected_updated_at, '2026-09-21T12:00:00Z');
});

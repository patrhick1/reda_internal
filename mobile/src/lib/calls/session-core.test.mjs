import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCallSession } from './session-core.ts';
import { errorMessage } from '../errors.ts';

const makeCall = (patch = {}) => ({
  id: 'call-1',
  caller_id: 'uzo',
  callee_id: 'funke',
  status: 'ringing',
  caller_device_uuid: 'phone-1',
  accepted_device_uuid: null,
  started_at: null,
  ringing_until: new Date(Date.now() + 45000).toISOString(),
  ...patch,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(overrides = {}) {
  const events = { connections: [], disconnections: 0, finishes: 0, renewals: [], audio: null };
  let active = null;
  const deps = {
    active: async () => active,
    get: async () => active ?? makeCall({ status: 'missed' }),
    token: async (id) => ({ token: `token-${id}`, app_id: 'test', channel: id, uid: 1 }),
    finish: async (call) => {
      events.finishes++;
      active = null;
      return { ...call, status: 'completed' };
    },
    connect: (token, callbacks) => {
      events.connections.push(token);
      events.audio = callbacks;
    },
    disconnect: () => {
      events.disconnections++;
    },
    renew: (token) => events.renewals.push(token),
    mute: () => {},
    speaker: () => {},
    dismiss: () => {},
    message: errorMessage,
    ...overrides,
  };
  const session = createCallSession(deps);
  session.setUser('uzo');
  return {
    session,
    events,
    setActive: (value) => {
      active = value;
    },
  };
}

test('leaving the call screen keeps audio, token refresh, and session state alive', async () => {
  const { session, events } = fixture();
  const unsubscribe = session.subscribe(() => {});
  await session.start(async () => makeCall());
  await tick();
  const disconnects = events.disconnections;
  unsubscribe(); // Back removes the screen subscriber, not the app-wide owner.
  events.audio.connected();
  events.audio.remote(true);
  events.audio.renew();
  await tick();
  assert.equal(events.disconnections, disconnects);
  assert.equal(session.getSnapshot().connected, true);
  assert.equal(session.getSnapshot().remoteJoined, true);
  assert.deepEqual(events.renewals, ['token-call-1']);
});

test('repeat taps resume the same call without joining audio again', async () => {
  const { session, events } = fixture();
  await session.start(async () => makeCall());
  await tick();
  await session.start(async () => makeCall({ status: 'accepted' }));
  await tick();
  assert.equal(events.connections.length, 1);
  assert.equal(session.getSnapshot().call.status, 'accepted');
});

test('concurrent start taps issue only one request', async () => {
  const { session } = fixture();
  const pending = deferred();
  let requests = 0;
  const begin = () => {
    requests++;
    return pending.promise;
  };
  const first = session.start(begin);
  const second = session.start(begin);
  pending.resolve(makeCall());
  assert.deepEqual(await first, await second);
  assert.equal(requests, 1);
});

test('cold restart restores ringing and accepted calls using the server state', async () => {
  for (const status of ['ringing', 'accepted']) {
    const { session, events, setActive } = fixture();
    setActive(makeCall({ status }));
    await session.refresh();
    await tick();
    assert.equal(session.getSnapshot().call.status, status);
    assert.equal(events.connections.length, 1);
  }
});

test('expiry or remote hang-up releases audio while the screen is minimized', async () => {
  const { session, events, setActive } = fixture();
  setActive(makeCall());
  await session.refresh();
  await tick();
  const disconnects = events.disconnections;
  setActive(null);
  await session.refresh();
  assert.equal(session.getSnapshot().call.status, 'missed');
  assert(events.disconnections > disconnects);
});

test('late token after End cannot resurrect the call', async () => {
  const token = deferred();
  const { session, events } = fixture({ token: () => token.promise });
  await session.start(async () => makeCall());
  await session.end();
  token.resolve({ token: 'late' });
  await tick();
  assert.equal(events.connections.length, 0);
  assert.equal(session.getSnapshot().call.status, 'completed');
});

test('late recovery cannot overwrite a newly started call', async () => {
  const old = deferred();
  const { session } = fixture({ active: () => old.promise });
  const recovery = session.refresh();
  await session.start(async () => makeCall({ id: 'new' }));
  old.resolve(makeCall({ id: 'old' }));
  await recovery;
  assert.equal(session.getSnapshot().call.id, 'new');
});

test('account switch rejects stale start/token results and clears audio', async () => {
  const pending = deferred();
  const { session, events } = fixture();
  const start = session.start(() => pending.promise);
  session.setUser('another-user');
  pending.resolve(makeCall());
  await assert.rejects(start, /session changed/);
  assert.equal(session.getSnapshot().call, null);
  assert.equal(events.connections.length, 0);
});

test('failed hang-up preserves readable error and controls for retry', async () => {
  let attempts = 0;
  const { session, events, setActive } = fixture({
    finish: async (call) => {
      if (++attempts === 1) throw { message: 'Network unavailable' };
      return { ...call, status: 'cancelled' };
    },
  });
  await session.start(async () => makeCall());
  await tick();
  await session.end();
  assert.equal(session.getSnapshot().ending, false);
  assert.equal(session.getSnapshot().call.status, 'ringing');
  assert.equal(session.getSnapshot().error, 'Network unavailable');
  const connections = events.connections.length;
  setActive(makeCall());
  await session.refresh();
  await tick();
  assert.equal(events.connections.length, connections, 'polling must not undo a failed hang-up');
  await session.end();
  assert.equal(session.getSnapshot().call.status, 'cancelled');
});

test('late incoming acceptance cannot attach to a different signed-in account', async () => {
  const { session, events } = fixture();
  session.setUser('another-user');
  session.adopt(makeCall({ status: 'accepted' }));
  await tick();
  assert.equal(session.getSnapshot().call, null);
  assert.equal(events.connections.length, 0);
});

test('token failure can recover without a second call or duplicate audio engine', async () => {
  let attempts = 0;
  const { session, setActive, events } = fixture({
    token: async () => {
      if (++attempts === 1) throw { message: 'Could not reach audio service' };
      return { token: 'retry' };
    },
  });
  setActive(makeCall());
  await session.refresh();
  await tick();
  assert.equal(session.getSnapshot().error, 'Could not reach audio service');
  await session.refresh();
  await tick();
  assert.equal(events.connections.length, 1);
  assert.equal(session.getSnapshot().error, null);
});

test('obsolete audio callbacks cannot mutate the next call', async () => {
  const { session, events } = fixture();
  await session.start(async () => makeCall());
  await tick();
  const oldEvents = events.audio;
  await session.end();
  await session.start(async () => makeCall({ id: 'new' }));
  await tick();
  oldEvents.connected();
  oldEvents.remote(true);
  oldEvents.error('old failure');
  assert.equal(session.getSnapshot().call.id, 'new');
  assert.equal(session.getSnapshot().connected, false);
  assert.equal(session.getSnapshot().remoteJoined, false);
  assert.equal(session.getSnapshot().error, null);
});

test('reconnecting preserves mute and speaker settings', async () => {
  const muted = [];
  const speaker = [];
  const { session, events } = fixture({
    mute: (value) => muted.push(value),
    speaker: (value) => speaker.push(value),
  });
  await session.start(async () => makeCall({ status: 'accepted' }));
  await tick();
  session.mute();
  session.speaker();
  session.reconnect();
  await tick();
  assert.equal(events.connections.length, 2);
  assert.equal(muted.at(-1), true);
  assert.equal(speaker.at(-1), true);
});

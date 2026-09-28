import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

// Exercise the actual platform adapter methods without loading native SDKs in Node.
const source = ts.createSourceFile(
  'session.ts',
  readFileSync(new URL('./session.ts', import.meta.url), 'utf8'),
  99,
  true,
);
function method(name, dependencies) {
  let text;
  function visit(node) {
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === name)
      text = node.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert(text);
  const code = ts.transpileModule(`const adapter = ({${text}}).${name};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return runInNewContext(`${code}\nadapter;`, dependencies);
}

test('Cancel racing acceptance ends the now-accepted call', async () => {
  let reads = 0;
  let ends = 0;
  const finish = method('finish', {
    getCall: async (id) => ({ id, status: ++reads === 1 ? 'ringing' : 'accepted' }),
    cancelCall: async () => {
      throw { message: 'already accepted', code: '55000' };
    },
    endCall: async (id) => {
      ends++;
      return { id, status: 'completed' };
    },
  });
  assert.equal((await finish({ id: 'call' })).status, 'completed');
  assert.equal(ends, 1);
});

test('a remotely ended call is safe to close again', async () => {
  const finish = method('finish', {
    getCall: async (id) => ({ id, status: 'missed' }),
    cancelCall: async () => {
      throw { message: 'already ended' };
    },
  });
  assert.equal((await finish({ id: 'call' })).status, 'missed');
});

test('audio handlers are registered before joining the native channel', () => {
  const order = [];
  let handler;
  const connect = method('connect', {
    agora: {
      getEngine: () => order.push('engine'),
      registerEventHandler: (value) => {
        handler = value;
        order.push('handlers');
      },
      joinChannel: () => {
        order.push('join');
        handler.onJoinChannelSuccess();
      },
    },
  });
  connect(
    { app_id: 'test', token: 'token', channel: 'channel', uid: 1 },
    {
      connected: () => order.push('connected'),
    },
  );
  assert.deepEqual(order, ['engine', 'handlers', 'join', 'connected']);
});

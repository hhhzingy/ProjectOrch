import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSessionRef, sameSession, sessionKey } from '../../packages/adapter-contract/dist/session-ref.js';

const ref = { harnessId: 'synthetic', hostId: 'test-host', profileId: 'test-profile', nativeConversationId: 'test-native-1' };
test('结构身份区分主机、配置档、Harness、分叉和工作区，重连不改变身份', () => {
  assert.equal(sameSession(ref, { ...ref }), true);
  for (const field of ['harnessId', 'hostId', 'profileId', 'nativeConversationId']) assert.equal(sameSession(ref, { ...ref, [field]: 'other' }), false);
  assert.equal(sameSession(ref, { ...ref, nativeWorkspaceId: 'workspace' }), false);
  assert.notEqual(sessionKey({ ...ref, hostId: 'a/b', profileId: 'c' }), sessionKey({ ...ref, hostId: 'a', profileId: 'b/c' }));
});
test('未知字段、自报标题、无原生ID和越界拒绝；引用不可变', () => {
  for (const input of [null, [], { ...ref, title: 'same title' }, { ...ref, toString: 'unknown' }, { ...ref, ['__proto__']: 'unknown' }, { ...ref, nativeConversationId: '' }, { ...ref, profileId: 'a'.repeat(129) }, { ...ref, nativeWorkspaceId: undefined }]) assert.throws(() => parseSessionRef(input));
  const value = parseSessionRef(ref);
  assert.equal(Object.isFrozen(value), true);
  assert.throws(() => { value.nativeConversationId = 'changed'; }, TypeError);
});

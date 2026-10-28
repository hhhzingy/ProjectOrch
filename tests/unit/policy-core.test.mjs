import assert from 'node:assert/strict';
import test from 'node:test';
import { USER_RESERVED_ACTIONS, authorize, parsePermissionProfile, pathMatches, validateGrant } from '../../packages/domain/dist/policy/index.js';

const profile = extra => parsePermissionProfile({ id: 'worker', revision: 3, actions: ['task.read', 'task.claim', 'message.send'], readPaths: ['tasks/*', 'roles/r1'], writePaths: ['tasks/*'], roleIds: [], delegableActions: ['task.read'], maxDelegationDepth: 1, ...extra });
const agent = (over = {}) => ({ kind: 'bound_agent', projectId: 'p1', roleId: 'r1', profile: profile(), roleDesiredState: 'enabled', delegationDepth: 0, ...over });
const req = (over = {}) => ({ action: 'task.claim', targetProjectId: 'p1', kind: 'write', ...over });

test('用户主体不受项目暂停与保留动作限制', () => {
  for (const paused of [false, true]) {
    assert.equal(authorize({ kind: 'local_user' }, req({ action: 'project.resume' }), { userPaused: paused }).allowed, true);
    assert.equal(authorize({ kind: 'local_user' }, req(), { userPaused: paused }).allowed, true);
  }
});

test('Agent常规授权与逐类拒绝', () => {
  assert.equal(authorize(agent(), req(), { userPaused: false }).allowed, true);
  assert.deepEqual(authorize(agent(), req({ action: 'project.pause' }), { userPaused: false }), { allowed: false, reason: 'USER_RESERVED' });
  assert.deepEqual(authorize(agent({ roleDesiredState: 'paused' }), req(), { userPaused: false }), { allowed: false, reason: 'ROLE_NOT_ENABLED' });
  assert.deepEqual(authorize(agent(), req({ targetProjectId: 'p2' }), { userPaused: false }), { allowed: false, reason: 'PROJECT_ISOLATION' });
  assert.deepEqual(authorize(agent(), req({ action: 'role.bind' }), { userPaused: false }), { allowed: false, reason: 'ACTION_NOT_GRANTED' });
  assert.deepEqual(authorize(agent(), req({ kind: 'read', action: 'task.read', path: 'roles/r9' }), { userPaused: false }), { allowed: false, reason: 'PATH_OUT_OF_SCOPE' });
  assert.equal(authorize(agent(), req({ kind: 'read', action: 'task.read', path: 'tasks/t1' }), { userPaused: false }).allowed, true);
  assert.deepEqual(authorize(agent(), {}, { userPaused: false }), { allowed: false, reason: 'UNKNOWN_ACTION' });
  assert.throws(() => authorize({}, req(), { userPaused: false }), /POLICY_PRINCIPAL_INVALID/);
  assert.throws(() => authorize(agent(), req(), {}), /POLICY_PRINCIPAL_INVALID/);
});

test('用户暂停阻断Agent写动作但保留读', () => {
  assert.deepEqual(authorize(agent(), req(), { userPaused: true }), { allowed: false, reason: 'PROJECT_PAUSED' });
  assert.equal(authorize(agent(), req({ kind: 'read', action: 'task.read', path: 'tasks/t1' }), { userPaused: true }).allowed, true);
});

test('档案解析拒绝用户保留动作与自扩大', () => {
  assert.throws(() => profile({ actions: ['project.resume'] }), /USER_RESERVED/);
  assert.throws(() => profile({ delegableActions: ['role.bind'] }), /DELEGATION_NOT_HELD/);
  assert.throws(() => profile({ readPaths: ['/abs'] }), /INVALID_PATHS/);
  assert.throws(() => profile({ revision: -1 }), /INVALID_REVISION/);
  assert.throws(() => profile({ maxDelegationDepth: 17 }), /INVALID_DEPTH/);
  assert.throws(() => profile({ actions: ['has space'] }), /INVALID_ACTIONS/);
  assert.ok(USER_RESERVED_ACTIONS.includes('project.pause'));
});

test('路径段级通配只匹配同深度', () => {
  assert.equal(pathMatches(['tasks/*'], 'tasks/t1'), true);
  assert.equal(pathMatches(['tasks/*'], 'tasks/t1/items'), false);
  assert.equal(pathMatches(['tasks/*/*'], 'tasks/t1/items'), true);
  assert.equal(pathMatches(['tasks/*'], 'roles/r1'), false);
  assert.equal(pathMatches([], 'tasks/t1'), false);
});

test('路径穿越与Windows别名形态一律不匹配（ZR-04负例）', () => {
  for (const evil of ['src/..', 'src/../secret', 'src/..\\secret.txt', 'src/.', '.', '..', 'src//x', '/abs', 'C:/x', 'c:secret', '\\\\server/share', 'a:b', 'src/x?', 'CON', 'src/NUL', 'src/x|y']) {
    assert.equal(pathMatches(['src/*'], evil), false, `must not match: ${evil}`);
    assert.equal(pathMatches(['src/*', 'tasks/*', 'a/..'], evil), false, `any pattern must not match: ${evil}`);
  }
  assert.equal(pathMatches(['src/*'], 'src/ok.txt'), true);
  assert.throws(() => profile({ readPaths: ['src/..'] }), /INVALID_PATHS/);
  assert.throws(() => profile({ readPaths: ['src\\\\x'] }), /INVALID_PATHS/);
  assert.throws(() => profile({ readPaths: ['C:/x'] }), /INVALID_PATHS/);
});

test('委派不得自扩大', () => {
  const parent = profile({ actions: ['task.read', 'task.claim'], delegableActions: ['task.read'], readPaths: ['tasks/*'], maxDelegationDepth: 2 });
  assert.equal(validateGrant(parent, parsePermissionProfile({ id: 'child', revision: 0, actions: ['task.read'], readPaths: ['tasks/*'], writePaths: [], roleIds: [], delegableActions: [], maxDelegationDepth: 0 }), 1).valid, true);
  const childEscalate = parsePermissionProfile({ id: 'child', revision: 0, actions: ['task.claim'], readPaths: [], writePaths: [], roleIds: [], delegableActions: [], maxDelegationDepth: 0 });
  assert.deepEqual(validateGrant(parent, childEscalate, 1), { valid: false, reason: 'ACTION_NOT_GRANTED' });
  const childReserved = { id: 'child', revision: 0, actions: ['project.resume'], readPaths: [], writePaths: [], roleIds: [], delegableActions: [], maxDelegationDepth: 0 };
  assert.deepEqual(validateGrant(parent, childReserved, 1), { valid: false, reason: 'USER_RESERVED' }, '绕过解析的原始对象在授予层被独立拦截');
  const childWidePath = parsePermissionProfile({ id: 'child', revision: 0, actions: ['task.read'], readPaths: ['roles/*'], writePaths: [], roleIds: [], delegableActions: [], maxDelegationDepth: 0 });
  assert.deepEqual(validateGrant(parent, childWidePath, 1), { valid: false, reason: 'PATH_OUT_OF_SCOPE' });
  const childRedelegate = parsePermissionProfile({ id: 'child', revision: 0, actions: ['task.read'], readPaths: ['tasks/*'], writePaths: [], roleIds: [], delegableActions: ['task.read'], maxDelegationDepth: 1 });
  assert.deepEqual(validateGrant(parent, childRedelegate, 2), { valid: false, reason: 'DELEGATION_DEPTH_EXCEEDED' }, '到达父深度边界后不得再挂剩余深度');
  assert.equal(validateGrant(parent, childRedelegate, 1).valid, true, '子层1剩余深度1未超父深2');
});

test('T037多层委派链：逐段收窄、中途越权拒绝、深度耗尽拒绝', async () => {
  const { validateDelegationChain } = await import('../../packages/domain/dist/policy/delegation.js');
  const parse = p => parsePermissionProfile(p);
  const layer0 = parse({ id: 'L0', revision: 0, actions: ['task.read', 'task.claim', 'message.send'], readPaths: ['tasks/*', 'messages/*'], writePaths: ['tasks/*', 'messages/*'], roleIds: [], delegableActions: ['task.read', 'message.send'], maxDelegationDepth: 3 });
  const layer1 = parse({ id: 'L1', revision: 0, actions: ['task.read', 'message.send'], readPaths: ['tasks/*'], writePaths: [], roleIds: [], delegableActions: ['task.read'], maxDelegationDepth: 2 });
  const layer2 = parse({ id: 'L2', revision: 0, actions: ['task.read'], readPaths: ['tasks/*'], writePaths: [], roleIds: [], delegableActions: [], maxDelegationDepth: 0 });
  const ok = validateDelegationChain([
    { profile: layer0, depth: 0 },
    { profile: layer1, depth: 1 },
    { profile: layer2, depth: 2 },
  ]);
  assert.deepEqual(ok, { valid: true, finalDepth: 2, links: 2 }, '三层逐段收窄链有效');
  // 中途越权：L1'试图持有L0未委派的task.claim
  const escalator = parse({ id: 'L1x', revision: 0, actions: ['task.claim'], readPaths: [], writePaths: [], roleIds: [], delegableActions: [], maxDelegationDepth: 0 });
  const rejected = validateDelegationChain([
    { profile: layer0, depth: 0 },
    { profile: escalator, depth: 1 },
  ]);
  assert.equal(rejected.valid, false);
  if (!rejected.valid) assert.equal(rejected.reason, 'ACTION_NOT_GRANTED');
  // 深度断裂：depth不连续
  const gap = validateDelegationChain([
    { profile: layer0, depth: 0 },
    { profile: layer1, depth: 2 },
  ]);
  assert.equal(gap.valid, false);
  if (!gap.valid) assert.equal(gap.reason, 'DELEGATION_DEPTH_EXCEEDED');
  // 深度耗尽：父剩余深度0时子层不得再持剩余委派
  const terminal = parse({ id: 'L2x', revision: 0, actions: ['task.read'], readPaths: ['tasks/*'], writePaths: [], roleIds: [], delegableActions: ['task.read'], maxDelegationDepth: 1 });
  const exhausted = validateDelegationChain([
    { profile: layer1, depth: 2 },
    { profile: terminal, depth: 3 },
  ]);
  assert.equal(exhausted.valid, false, '父maxDelegationDepth=2时深度3的子层耗尽');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSupportedNode } from '../../packages/runtime/dist/index.js';

test('运行时支持当前基线和锁定 Node 24 目标', () => {
  for (const version of ['24.14.0', 'v24.22.0', '24.22.1']) {
    assert.doesNotThrow(() => assertSupportedNode(version));
  }
});

test('旧版本、未测试主版本和畸形版本拒绝启动', () => {
  for (const version of ['24.13.9', '22.22.0', '26.0.0', '24.22', '24.22.0-preview', '', '24.22.0\n']) {
    assert.throws(() => assertSupportedNode(version), /不支持的 Node.js/);
  }
});

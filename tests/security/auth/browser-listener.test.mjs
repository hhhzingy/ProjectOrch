import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { browserHttpPortAllowed, listenBrowserLoopback } from '../../../apps/kernel/dist/http/browser-listener.js';

class SyntheticListener extends EventEmitter {
  listening = false; opens = 0; closes = 0; destroyed = 0;
  constructor(ports) { super(); this.ports = ports; }
  listen(port, host, done) { assert.equal(port, 0); assert.equal(host, '127.0.0.1'); this.port = this.ports[Math.min(this.opens++, this.ports.length - 1)]; this.listening = true; queueMicrotask(done); return this; }
  address() { return { port: this.port }; }
  close(done) { this.listening = false; this.closes++; queueMicrotask(done); }
  closeAllConnections() { this.destroyed++; }
}

test('系统临时端口命中Fetch禁用端口时关闭重选，来源只使用最终实际端口', async () => {
  const server = new SyntheticListener([6000, 6667, 41000]);
  assert.equal(await listenBrowserLoopback(server), 41000); assert.equal(server.opens, 3); assert.equal(server.closes, 2); assert.equal(server.destroyed, 2);
  assert.equal(server.listening, true); assert.equal(server.listenerCount('error'), 0);
  await assert.rejects(() => listenBrowserLoopback(server), /ALREADY_LISTENING/);
});

test('持续命中禁用端口有界失败且全部关闭，不保留错误监听器', async () => {
  const server = new SyntheticListener([10080]); await assert.rejects(() => listenBrowserLoopback(server), /NO_BROWSER_SAFE_PORT/);
  assert.equal(server.opens, 16); assert.equal(server.closes, 16); assert.equal(server.listening, false); assert.equal(server.listenerCount('error'), 0);
  for (const invalid of [0, 80, 1023, 1719, 5060, 6000, 6669, 10080, 65536, NaN, 4000.5]) assert.equal(browserHttpPortAllowed(invalid), false);
});

test('实际地址不可用会关闭监听，监听错误保留原错且移除错误处理器', async () => {
  const unavailable = new SyntheticListener([41000]); unavailable.address = () => null;
  await assert.rejects(() => listenBrowserLoopback(unavailable), /ADDRESS_UNAVAILABLE/);
  assert.equal(unavailable.listening, false); assert.equal(unavailable.closes, 1);
  const failed = new SyntheticListener([41000]); failed.listen = () => { queueMicrotask(() => failed.emit('error', new Error('synthetic-bind-error'))); };
  await assert.rejects(() => listenBrowserLoopback(failed), /synthetic-bind-error/); assert.equal(failed.listenerCount('error'), 0);
});

test('真实回环HTTP监听可被Fetch访问，禁用6000端口可复现bad port失败', async t => {
  const server = createServer((_request, response) => response.end('browser-ready'));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const port = await listenBrowserLoopback(server); assert.equal(browserHttpPortAllowed(port), true);
  const response = await fetch(`http://127.0.0.1:${port}`); assert.equal(await response.text(), 'browser-ready');
  await assert.rejects(() => fetch('http://127.0.0.1:6000'), error => /bad port/.test(String(error.cause?.message)));
});

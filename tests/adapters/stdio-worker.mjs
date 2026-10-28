import readline from 'node:readline';
const mode = process.argv[2];
const lines = readline.createInterface({ input: process.stdin });
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
let originalRequest;
lines.on('line', line => {
  const frame = JSON.parse(line);
  if (!frame.method) {
    if (mode === 'trusted-handler') emit({ id: originalRequest, result: frame });
    if (mode === 'server-request') emit({ id: 'ignored-server-reply', result: null });
    return;
  }
  if (mode === 'trusted-handler') {
    originalRequest = frame.id;
    emit({ id: 'runtime-preferences', method: frame.params.serverMethod, params: { scope: 'synthetic' } });
    return;
  }
  if (mode === 'silent') return;
  if (mode === 'exit') { process.exit(7); }
  if (mode === 'malformed') { process.stdout.write('{bad\n'); return; }
  if (mode === 'oversize') { process.stdout.write('x'.repeat(2048)); return; }
  if (mode === 'error') { emit({ id: frame.id, error: { code: 403, message: 'synthetic-secret-not-for-error' } }); return; }
  if (mode === 'ambiguous') { emit({ id: frame.id, result: {}, error: {} }); return; }
  if (mode === 'null-error') { emit({ id: frame.id, error: null }); return; }
  if (mode === 'empty-error') { emit({ id: frame.id, error: {} }); return; }
  if (mode === 'array-error') { emit({ id: frame.id, error: [] }); return; }
  if (mode === 'string-code-error') { emit({ id: frame.id, error: { code: '403', message: 'synthetic' } }); return; }
  if (mode === 'no-message-error') { emit({ id: frame.id, error: { code: 403 } }); return; }
  if (mode === 'server-request') emit({ id: 'synthetic-approval', method: 'interaction/requestPermission', params: {} });
  if (mode === 'notification') emit({ method: 'synthetic/event', params: { value: 1 } });
  emit({ id: 'wrong-request-id', result: 'wrong-result' });
  if (mode === 'split') {
    const bytes = Buffer.from(`${JSON.stringify({ id: frame.id, result: { text: '中文' } })}\n`);
    const index = bytes.indexOf(Buffer.from('中')) + 1;
    process.stdout.write(bytes.subarray(0, index));
    setImmediate(() => process.stdout.write(bytes.subarray(index)));
  } else emit({ id: frame.id, result: { method: frame.method, params: frame.params } });
});
lines.on('close', () => process.exit(0));

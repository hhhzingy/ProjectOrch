const text = process.argv[process.argv.indexOf('--prompt') + 1];
const sessionIndex = process.argv.indexOf('--resume');
const sessionId = sessionIndex < 0 ? 'synthetic-new-session' : process.argv[sessionIndex + 1];
if (text === 'exit') process.exit(1);
if (text === 'silent') setInterval(() => {}, 1000);
else if (text === 'bad') process.stdout.write('{bad\n');
else {
  if (text === 'delayed') {
    process.stdout.write(`${JSON.stringify({ type: 'turn.started', sessionId, turnId: 'synthetic-turn' })}\n`);
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  process.stderr.write('synthetic-secret-not-for-report');
  const result = { type: 'result', sessionId: text === 'wrong-session' ? 'other-session' : sessionId, turnId: 'synthetic-turn', response: text, projection: { status: 'idle', turnCount: 1 }, ...(text === 'result-error' ? { isError: true } : {}) };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

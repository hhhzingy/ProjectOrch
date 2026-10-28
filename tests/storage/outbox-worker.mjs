import fs from 'node:fs';
import { openStore } from '../../packages/persistence/dist/index.js';
import { claimOutbox } from '../../packages/persistence/dist/outbox/index.js';

const [filename, mode, marker] = process.argv.slice(2);
const store = openStore(filename);
if (mode === 'crash') {
  const lease = claimOutbox(store, 100, 10);
  fs.writeFileSync(marker, JSON.stringify(lease), { flush: true });
  process.kill(process.pid, 'SIGKILL');
} else if (mode === 'compete') {
  process.once('message', () => {
    try {
      const lease = claimOutbox(store, 100, 10);
      store.close();
      process.send({ result: lease }, () => process.disconnect());
    } catch (error) {
      process.send({ error: error.message }, () => { store.close(); process.disconnect(); process.exitCode = 1; });
    }
  });
  process.send({ ready: true });
} else {
  store.close();
  throw new Error('UNKNOWN_TEST_MODE');
}

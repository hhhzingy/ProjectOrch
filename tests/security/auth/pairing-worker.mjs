import { openStore } from '../../../packages/persistence/dist/index.js';
import { consumePairingChallenge } from '../../../apps/kernel/dist/auth/pairing.js';

const store = openStore(process.argv[2]);
process.once('message', ({ request, now }) => {
  try {
    const result = store.transaction(db => consumePairingChallenge(db, request, now));
    store.close();
    process.send({ accepted: result.accepted }, () => process.disconnect());
  } catch {
    store.close();
    process.send({ error: 'PAIRING_WORKER_FAILED' }, () => { process.disconnect(); process.exitCode = 1; });
  }
});
process.send({ ready: true });

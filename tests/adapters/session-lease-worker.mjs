import { NativeSessionLease } from '../../apps/kernel/dist/native/session-lease.js';
const session = JSON.parse(process.argv[3]);
try {
  const lease = NativeSessionLease.acquire(process.argv[2], session);
  process.send({ status: 'acquired' });
  process.on('message', message => {
    if (message === 'release') { lease.releaseAfterExit(true); process.send({ status: 'released' }); process.disconnect(); }
    if (message === 'crash') process.exit(9);
  });
} catch (error) { process.send({ status: error.message }); process.disconnect(); }

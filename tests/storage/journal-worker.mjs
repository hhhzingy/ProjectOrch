import { openStore } from '../../packages/persistence/dist/index.js';
import { applySyntheticCommand, request } from './journal-fixture.mjs';

const store = openStore(process.argv[2]);
process.once('message', () => {
  try {
    const result = applySyntheticCommand(store, 'synthetic-principal', `command-${process.pid}`, request());
    store.close();
    process.send({ result }, () => process.disconnect());
  } catch (error) {
    store.close();
    process.send({ error: error.message }, () => { process.disconnect(); process.exitCode = 1; });
  }
});
process.send({ ready: true });

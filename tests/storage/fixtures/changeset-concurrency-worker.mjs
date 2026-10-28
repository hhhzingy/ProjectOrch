import { openStore } from '../../../packages/persistence/dist/index.js';
import { applyChangeset } from '../../../packages/domain/dist/changesets/index.js';

const [filename, commandId] = process.argv.slice(2);
const store = openStore(filename, { busyTimeoutMs: 10000 });
store.transaction(db => db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES(?,'p1','synthetic-manager',?,?,'management.apply_changes','{}','stored',100)").run(commandId, commandId, '0'.repeat(64)));
process.on('message', message => {
  if (message !== 'go') return;
  let outcome;
  try {
    const result = applyChangeset(store, commandId, { schemaVersion: 2, requestId: commandId, projectId: 'p1', expectedPlanRevision: 0, reason: '合成并发测试', operations: [
      { type: 'role.create', localRef: `role-${commandId}`, name: commandId, charter: 'test', scopePaths: [], permissionProfileId: 'worker', permissionProfileRevision: 0 },
    ] }, 120);
    outcome = { ok: true, result };
  } catch (error) { outcome = { ok: false, error: error.message }; }
  store.close();
  process.send(outcome, () => process.disconnect());
});
process.send({ ready: true });

import { openStore } from '../../packages/persistence/dist/index.js';
import { writeSync } from 'node:fs';

const store = openStore(process.argv[2]);
store.transaction(db => {
  db.prepare("UPDATE projects SET revision=1 WHERE id='p1'").run();
  db.prepare("INSERT INTO events(id,project_id,type,entity_id,entity_revision,body_json,occurred_at) VALUES('e1','p1','test','p1',1,'{}',0)").run();
  db.prepare("INSERT INTO outbox(id,command_id,operation_key,payload_json,state,next_attempt_at) VALUES('o1','c1','op1','{}','pending',0)").run();
  if (process.argv[3] === 'before') {
    writeSync(1, 'CRASH_POINT:before\n');
    process.kill(process.pid, 'SIGKILL');
  }
});
writeSync(1, 'CRASH_POINT:after\n');
process.kill(process.pid, 'SIGKILL');

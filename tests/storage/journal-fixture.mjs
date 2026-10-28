/** 仅供合成测试的领域动作；不是生产 project.resume 实现或认证入口。 */
import { reserveCommand, commitCommandReceipt } from '../../packages/persistence/dist/commands/index.js';
import { enqueueOutbox } from '../../packages/persistence/dist/outbox/index.js';

export const request = (overrides = {}) => ({ schemaVersion: 2, requestId: 'synthetic-request', projectId: 'p1', type: 'project.resume', payload: { expectedRevision: 0, reason: 'synthetic' }, ...overrides });
export function applySyntheticCommand(store, principalId, commandId, input, injectFailure = false) {
  return store.transaction(db => {
    const reservation = reserveCommand(db, principalId, commandId, input, 100);
    if (reservation.replay) return reservation;
    const changed = db.prepare('UPDATE projects SET revision=revision+1 WHERE id=? AND revision=?').run(input.projectId, input.payload.expectedRevision);
    if (Number(changed.changes) !== 1) throw new Error('REVISION_CONFLICT');
    const event = db.prepare("INSERT INTO events(id,project_id,type,entity_id,entity_revision,causation_id,body_json,occurred_at) VALUES(?,?,'test.command',?,?,?,'{}',100)").run(`${commandId}-event`, input.projectId, input.projectId, input.payload.expectedRevision + 1, commandId);
    enqueueOutbox(db, { id: `${commandId}-outbox`, commandId, operationKey: `${commandId}:synthetic`, payload: { kind: 'synthetic-no-send' }, nextAttemptAt: 100 });
    const receipt = commitCommandReceipt(db, principalId, commandId, {
      requestId: input.requestId, projectId: input.projectId, commandId, status: 'queued', receiptUrl: `/api/v1/receipts/${encodeURIComponent(input.requestId)}`,
      entityIds: [{ localRef: 'project', entityType: 'project', id: input.projectId, revision: input.payload.expectedRevision + 1, version: null }], error: null, lastEventSequence: Number(event.lastInsertRowid),
    });
    if (injectFailure) throw new Error('INJECTED_AFTER_RECEIPT');
    return { replay: false, commandId, receipt };
  });
}

import { createHash, randomUUID } from "node:crypto";
import type { Store } from "@projectorch/persistence";
import { canonicalJson } from "@projectorch/persistence/outbox";
import { parseContract } from "@projectorch/contracts";
import { reserveCommand, reserveMessageCommand, reserveResultCommand, reserveChangesetCommand, type CommandReservation } from "@projectorch/persistence/commands";
import { assertAgentPrincipalCurrent, type AgentPrincipal } from "../auth/agent-credential.js";

/** 调用者先核验当前动作/范围；来源仅取已认证主体。历史命令/回执/副作用不改写。 */
export function reserveAgentOperationWithin(store: Store, principal: AgentPrincipal, type: string, input: unknown, now: number): { readonly reservation: CommandReservation; readonly sourcePrincipalId: string } {
  const db = store.db;
  if (!db.isTransaction) throw new Error("AGENT_COMMAND_TRANSACTION_REQUIRED");
  assertAgentPrincipalCurrent(store, principal, now);
  const strict: unknown = JSON.parse(canonicalJson(input));
  const command = type === "message.send" ? (() => { const message = parseContract("message", strict); return { schemaVersion: 2 as const, requestId: message.requestId, projectId: message.projectId, type, payload: message }; })()
    : type === "task.submit_result" ? (() => { const result = parseContract("result", strict); return { schemaVersion: 2 as const, requestId: result.requestId, projectId: result.projectId, type, payload: result }; })()
    : type === 'management.apply_changes' ? (()=>{const changeset=parseContract('changeset',strict);return {schemaVersion:2 as const,requestId:changeset.requestId,projectId:changeset.projectId,type,payload:changeset};})()
    : parseContract("command", strict);
  if (command.type !== type || command.projectId !== principal.projectId) throw new Error("AGENT_COMMAND_PROJECT_MISMATCH");
  const hash = createHash("sha256").update(canonicalJson(command)).digest("hex");
  const historical = db.prepare("SELECT c.id,c.project_id,c.request_id,c.request_hash,c.state,c.receipt_json,c.source_principal_id FROM agent_command_scopes s JOIN commands c ON c.id=s.command_id WHERE s.project_id=? AND s.role_id=? AND s.request_id=? ORDER BY c.id").all(principal.projectId, principal.roleId, command.requestId);
  if (historical.length > 1) throw new Error("AGENT_COMMAND_HISTORY_AMBIGUOUS");
  if (historical.length === 1) {
    const row = historical[0];
    if (!row || row.request_hash !== hash || row.project_id !== principal.projectId) throw new Error("IDEMPOTENCY_CONFLICT");
    if (row.receipt_json === null) throw new Error("COMMAND_INCOMPLETE");
    const receipt = parseContract("receipt", JSON.parse(String(row.receipt_json)));
    if (receipt.commandId !== row.id || receipt.projectId !== principal.projectId || receipt.requestId !== command.requestId || receipt.status !== row.state || (receipt.error && receipt.error.requestId !== command.requestId)) throw new Error("COMMAND_RECEIPT_TARGET_MISMATCH");
    return { sourcePrincipalId: String(row.source_principal_id), reservation: { replay: true, commandId: String(row.id), receipt } };
  }
  db.prepare("INSERT INTO agent_role_sources(project_id,role_id,source_principal_id) VALUES(?,?,?) ON CONFLICT(project_id,role_id) DO NOTHING").run(principal.projectId, principal.roleId, `agent-role-${randomUUID()}`);
  const source = db.prepare("SELECT source_principal_id FROM agent_role_sources WHERE project_id=? AND role_id=?").get(principal.projectId, principal.roleId);
  if (!source) throw new Error("AGENT_COMMAND_SOURCE_MISSING");
  const sourcePrincipalId = String(source.source_principal_id), id = randomUUID();
  const reservation = type === "message.send" ? reserveMessageCommand(db, sourcePrincipalId, id, command.payload, now)
    : type === "task.submit_result" ? reserveResultCommand(db, sourcePrincipalId, id, command.payload, now)
    : type === 'management.apply_changes' ? reserveChangesetCommand(db,sourcePrincipalId,id,command.payload,now)
    : reserveCommand(db, sourcePrincipalId, id, command, now);
  if (reservation.replay) throw new Error("AGENT_COMMAND_SCOPE_MISSING");
  db.prepare("INSERT INTO agent_command_scopes(command_id,project_id,role_id,request_id,credential_id) VALUES(?,?,?,?,?)").run(reservation.commandId, principal.projectId, principal.roleId, command.requestId, principal.credentialId);
  return { reservation, sourcePrincipalId };
}

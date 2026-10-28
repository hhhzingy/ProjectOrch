import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { parseContract, type ContractRegistry } from "@projectorch/contracts";
import { canonicalJson } from "../outbox/json.js";

export type Receipt = ContractRegistry["receipt"];
export interface RoleModelPreferenceCommand {readonly schemaVersion:2;readonly requestId:string;readonly projectId:string;readonly roleId:string;readonly expectedRevision:number;readonly expectedModelRevision:number;readonly resetToDefault?:boolean;readonly modelRequested?:string;readonly modelId?:string;readonly reasoningLevel?:string;}

/** 开发期Web配置入口的固定载荷；不扩展普通Agent命令权限或接受任意命令类型。 */
export function parseRoleModelPreferenceCommand(raw:unknown):RoleModelPreferenceCommand{
 const p=JSON.parse(canonicalJson(raw)) as Record<string,unknown>;
 const allowed=new Set(['schemaVersion','requestId','projectId','roleId','expectedRevision','expectedModelRevision','resetToDefault','modelRequested','modelId','reasoningLevel']);
 if(!p||typeof p!=='object'||Array.isArray(p)||p.schemaVersion!==2||Object.keys(p).some(k=>!allowed.has(k)))throw new Error('MODEL_PREFERENCE_VALIDATION_ERROR');
 for(const key of ['requestId','projectId','roleId'])if(typeof p[key]!=='string'||!p[key]||p[key].length>128)throw new Error('MODEL_PREFERENCE_VALIDATION_ERROR');
 if(!Number.isSafeInteger(p.expectedRevision)||Number(p.expectedRevision)<1||!Number.isSafeInteger(p.expectedModelRevision)||Number(p.expectedModelRevision)<0)throw new Error('MODEL_CONFIG_VERSION_REQUIRED');
 if(p.resetToDefault!==undefined&&typeof p.resetToDefault!=='boolean')throw new Error('MODEL_PREFERENCE_VALIDATION_ERROR');
 if(p.resetToDefault===true){if(['modelRequested','modelId','reasoningLevel'].some(k=>Object.hasOwn(p,k)))throw new Error('MODEL_PREFERENCE_VALIDATION_ERROR');}
 else{
  if(typeof p.modelRequested!=='string'||!p.modelRequested.trim()||p.modelRequested.length>512)throw new Error('MODEL_PREFERENCE_VALIDATION_ERROR');
  for(const [key,max] of [['modelId',128],['reasoningLevel',32]] as const)if(p[key]!==undefined&&(typeof p[key]!=='string'||p[key].length>max))throw new Error('MODEL_PREFERENCE_VALIDATION_ERROR');
 }
 return p as unknown as RoleModelPreferenceCommand;
}

export function reserveRoleModelPreferenceCommand(db:DatabaseSync,principalId:string,commandId:string,raw:unknown,now:number):CommandReservation{
 inTransaction(db);token(principalId);token(commandId);if(!Number.isSafeInteger(now)||now<0)throw new Error('INVALID_COMMAND_TIME');
 const input=parseRoleModelPreferenceCommand(raw);
 return reserveValidatedCommand(db,principalId,commandId,{schemaVersion:2,requestId:input.requestId,projectId:input.projectId,type:'role.model_preference.configure',payload:input},now);
}
export type CommandReservation = { readonly replay: false; readonly commandId: string } | { readonly replay: true; readonly commandId: string; readonly receipt: Receipt };

function inTransaction(db: DatabaseSync): void {
  if (!db.isTransaction) throw new Error("COMMAND_TRANSACTION_REQUIRED");
}
function token(value: string): void {
  if (typeof value !== "string" || !value.length || value.length > 128) throw new Error("INVALID_COMMAND_TOKEN");
}
function linkedReceipt(input: unknown, commandId: string, projectId: string, requestId: string): Receipt {
  const receipt = parseContract("receipt", input);
  if (receipt.commandId !== commandId || receipt.projectId !== projectId || receipt.requestId !== requestId || (receipt.error && receipt.error.requestId !== requestId)) throw new Error("COMMAND_RECEIPT_TARGET_MISMATCH");
  return receipt;
}

/** 仅供已完成认证及当前权限核验的受信内核事务；principalId 必须来自正文以外。 */
export function reserveCommand(db: DatabaseSync, principalId: string, commandId: string, input: unknown, now: number): CommandReservation {
  inTransaction(db); token(principalId); token(commandId);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_COMMAND_TIME");
  // 先约束严格 JSON，拒绝访问器/非JSON值，再从固定 v2 Schema 校验。
  const command = parseContract("command", JSON.parse(canonicalJson(input)));
  return reserveValidatedCommand(db, principalId, commandId, command, now);
}

/** 消息使用独立message合同，仍进入同一来源/幂等/回执账本，不能借用其他命令ID。 */
export function reserveMessageCommand(db: DatabaseSync, principalId: string, commandId: string, input: unknown, now: number): CommandReservation {
  inTransaction(db); token(principalId); token(commandId);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_COMMAND_TIME");
  const message = parseContract("message", JSON.parse(canonicalJson(input)));
  return reserveValidatedCommand(db, principalId, commandId, { schemaVersion: 2, requestId: message.requestId, projectId: message.projectId, type: "message.send", payload: message }, now);
}

function reserveValidatedCommand(db: DatabaseSync, principalId: string, commandId: string, command: { readonly schemaVersion: number; readonly requestId: string; readonly projectId: string; readonly type: string; readonly payload: unknown }, now: number): CommandReservation {
  const serialized = canonicalJson(command);
  const digest = createHash("sha256").update(serialized).digest("hex");
  if (db.prepare("SELECT 1 FROM global_requests WHERE principal_id=? AND request_id=?").get(principalId, command.requestId)) throw new Error("IDEMPOTENCY_CONFLICT");
  const existing = db.prepare("SELECT id,project_id,request_hash,state,receipt_json FROM commands WHERE source_principal_id=? AND request_id=?").get(principalId, command.requestId);
  if (existing) {
    if (existing.request_hash !== digest || existing.project_id !== command.projectId) throw new Error("IDEMPOTENCY_CONFLICT");
    if (existing.receipt_json === null) throw new Error("COMMAND_INCOMPLETE");
    const receipt = linkedReceipt(JSON.parse(String(existing.receipt_json)), String(existing.id), command.projectId, command.requestId);
    if (receipt.status !== existing.state) throw new Error("COMMAND_RECEIPT_STATE_MISMATCH");
    return { replay: true, commandId: String(existing.id), receipt };
  }
  db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES(?,?,?,?,?,?,?,'stored',?)").run(commandId, command.projectId, principalId, command.requestId, digest, command.type, canonicalJson(command.payload), now);
  return { replay: false, commandId };
}

/** 结果沿用独立result合同，并使用统一命令账本。 */
export function reserveResultCommand(db: DatabaseSync, principalId: string, commandId: string, input: unknown, now: number): CommandReservation {
  inTransaction(db); token(principalId); token(commandId);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_COMMAND_TIME");
  const result = parseContract("result", JSON.parse(canonicalJson(input)));
  return reserveValidatedCommand(db, principalId, commandId, { schemaVersion: 2, requestId: result.requestId, projectId: result.projectId, type: "task.submit_result", payload: result }, now);
}

/** 管理变更集使用独立固定合同，来源/请求命名空间与其他命令共用。 */
export function reserveChangesetCommand(db: DatabaseSync, principalId: string, commandId: string, input: unknown, now: number): CommandReservation {
  inTransaction(db); token(principalId); token(commandId);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_COMMAND_TIME");
  const changeset = parseContract("changeset", JSON.parse(canonicalJson(input)));
  return reserveValidatedCommand(db, principalId, commandId, { schemaVersion: 2, requestId: changeset.requestId, projectId: changeset.projectId, type: "management.apply_changes", payload: changeset }, now);
}

/** 同一事务内保存首次处理回执；不提供后续外部动作完成/未知恢复的捷径。 */
export function commitCommandReceipt(db: DatabaseSync, principalId: string, commandId: string, input: unknown): Receipt {
  inTransaction(db); token(principalId); token(commandId);
  const command = db.prepare("SELECT project_id,request_id,state,receipt_json FROM commands WHERE id=? AND source_principal_id=?").get(commandId, principalId);
  if (!command) throw new Error("COMMAND_NOT_FOUND");
  if (command.state !== "stored" || command.receipt_json !== null) throw new Error("COMMAND_ALREADY_FINISHED");
  const receipt = linkedReceipt(JSON.parse(canonicalJson(input)), commandId, String(command.project_id), String(command.request_id));
  if (!["stored", "queued", "completed", "failed"].includes(receipt.status)) throw new Error("INVALID_INITIAL_RECEIPT_STATE");
  const lastSequence = Number(db.prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM events WHERE project_id=?").get(String(command.project_id))?.n);
  if (receipt.lastEventSequence !== lastSequence) throw new Error("COMMAND_RECEIPT_SEQUENCE_MISMATCH");
  db.prepare("UPDATE commands SET state=?,receipt_json=? WHERE id=? AND source_principal_id=?").run(receipt.status, canonicalJson(receipt), commandId, principalId);
  return receipt;
}

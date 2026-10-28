/** T023：Agent网关工具派发器（docs/16合同域实现）。身份来自已认证连接主体（AgentPrincipal），不来自正文；
 * 每次调用实时核验授权（authorizeAgentAction：主体状态+档案动作+项目隔离+暂停+路径范围）；
 * 写动作进入统一命令管线（reserveCommand→域事务内变体→事件→Outbox→回执，单事务全有或全无）；
 * own类工具接收者/来源强制取principal，正文roleId/fromRoleId无法覆盖；
 * task.claim承接已确认运行的精确占位，report保存业务等待，accept汇总指定规则；管理Agent变更仍先授权后显式不支持。 */
import { randomUUID, createHash } from "node:crypto";
import type { Store } from "@projectorch/persistence";
import { commitCommandReceipt } from "@projectorch/persistence/commands";
import { enqueueOutbox } from "@projectorch/persistence/outbox";
import { assertAgentPrincipalCurrent, type AgentPrincipal } from "../auth/agent-credential.js";
import { authorizeAgentAction } from "../auth/policy-check.js";
import { sendMessageWithin, acknowledgeMessageWithin, resolveMessageWithin } from "@projectorch/domain/messages";
import { parseContract,parseToolArguments } from "@projectorch/contracts";
import { registerArtifactWithin, readArtifactRecord, resolveWithinProject } from "@projectorch/domain/artifacts";
import { registerGitArtifactWithin, assertGitArtifactSource, repositoryScope } from "@projectorch/domain/artifacts/git";
import { claimTaskWithin, reportTaskWithin } from "./task-workflow.js";
import { taskAcceptanceWithin } from "../commands/task-acceptance.js";
import { submitResultWithin } from "@projectorch/domain/results";
import { raiseIssueWithin, listOpenIssues } from "@projectorch/domain/issues";
import { completeStartupAckWithin } from "@projectorch/domain/bootstrap";
import { canonicalJson } from "@projectorch/persistence/outbox";
import { readProject } from "@projectorch/domain/projects";
import { readRole } from "@projectorch/domain/roles";
import { queryForAgent } from "./agent-queries.js";
import { reserveAgentOperationWithin } from "../commands/agent-command-source.js";
import { artifactContentForAgent } from "./artifact-content.js";
import {applyChangesetForAgent} from '../commands/agent-changesets.js';
import {askQuestionWithin,answerQuestionWithin} from './question-workflow.js';
import {prepareHandoverWithin,verifyHandoverWithin,requestIntegrationWithin,handoverContract,integrationContract} from './collaboration-workflow.js';
import {queueRoleProvisionWithin} from './role-provisioning.js';
import {readOperation} from './orchestration-tools.js';
import {evaluateIntegrationWithin,reviewIntegrationWithin,readIntegrationRunWithin} from '../integration/verification.js';
import {assertAgentArtifactFile} from './artifact-file-check.js';

export interface ToolCallResult {
  readonly tool: string;
  readonly ok: boolean;
  readonly payload: unknown;
}

export interface ToolDispatcherServices {
  /** 接收者角色档案（policy层要求已解析对象）。 */
  readonly profileInput?: unknown;
  readonly now: () => number;
  /** 来源必须由可信传输层提供，不能取请求正文或模型参数；缺失时拒绝。
   * 此处比对是内核防线，不自行证明原生传输来源隔离。Browser不走Agent派发器。 */
  readonly callerNativeConversationId: string;
  /** 当前原生执行ID由可信宿主提供，不能取模型正文。领取/进展回报必须精确匹配已占位执行。 */
  readonly callerNativeExecutionId?: string;
  /** 受信宿主闭包；写事务中再次验证来源/租约/当前执行，不能从工具参数构造。 */
  readonly assertTrustedConnection?: () => void;
}

type WithinDb = Parameters<Parameters<Store["transaction"]>[0]>[0];
type ToolHandler = (store: Store, principal: AgentPrincipal, args: Record<string, unknown>) => unknown;

export interface ToolActionSpec {
  readonly action: string;
  readonly kind: "read" | "write" | "control";
}

/** docs/16工具→动作映射（最低权限）；read类kind=read，写类kind=write。 */
const TOOL_ACTIONS: Readonly<Record<string, ToolActionSpec>> = {
  'role.provision':{action:'role.bind',kind:'write'},
  'handover.prepare':{action:'handover.prepare',kind:'write'},
  'handover.verify':{action:'handover.verify',kind:'write'},
  'handover.read':{action:'handover.read',kind:'read'},
  'integration.request':{action:'integration.request',kind:'write'},
  'integration.read':{action:'integration.read',kind:'read'},
  'integration.run.read':{action:'integration.read',kind:'read'},
  'integration.evaluate':{action:'task.accept_assigned',kind:'write'},
  'integration.review':{action:'task.accept_assigned',kind:'write'},
  'check.read':{action:'check.read',kind:'read'},
  "management.apply_changes": {action:'change.apply',kind:'write'},
  "question.ask":{action:'question.ask',kind:'write'},
  "question.answer":{action:'question.answer_designated',kind:'write'},
  "question.read":{action:'question.read',kind:'read'},
  "question.list":{action:'question.read',kind:'read'},
  "identity": { action: "identity", kind: "read" },
  "project.snapshot": { action: "project.read", kind: "read" },
  "role.list": { action: "role.read", kind: "read" },
  "role.read": { action: "role.read", kind: "read" },
  "task.read": { action: "task.read", kind: "read" },
  "result.read": { action: "task.read", kind: "read" },
  "task.list": { action: "task.read", kind: "read" },
  "policy.read": { action: "policy.read", kind: "read" },
  "inbox.read": { action: "message.read_own", kind: "read" },
  "message.send": { action: "message.send", kind: "write" },
  "message.ack": { action: "message.ack_own", kind: "write" },
  "artifact.register": { action: "artifact.register_own", kind: "write" },
  "artifact.read": { action: "artifact.read", kind: "read" },
  "artifact.content": { action: "artifact.read", kind: "read" },
  "task.submit_result": { action: "task.submit_own", kind: "write" },
  "issue.raise": { action: "case.raise", kind: "write" },
  "issue.read": { action: "case.read", kind: "read" },
  "role.startup_ack": { action: "role.startup_ack", kind: "write" },
  "task.claim": { action: "task.claim", kind: "write" },
  "task.report": { action: "task.report_own", kind: "write" },
  "task.accept": { action: "task.accept_assigned", kind: "write" },
};

/** 合同已列、域处理器属正式任务（T028/T030/T033）的工具：先授权再显式不支持，不向未授权方泄露能力面。 */
const PENDING_TOOL_ACTIONS: Readonly<Record<string, ToolActionSpec>> = {
};

export const unsupportedTools: readonly string[] = Object.keys(PENDING_TOOL_ACTIONS);
/** 返回副本，工具目录不能改写网关的授权映射。 */
export function toolAction(name: string): ToolActionSpec | null { const action = TOOL_ACTIONS[name]; return action ? Object.freeze({ ...action }) : null; }

function requireArgs(args: Record<string, unknown>, names: readonly string[]): void {
  for (const name of names) if (!(name in args)) throw new Error(`TOOL_ARG_MISSING:${name}`);
}
function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("TOOL_ARGS_INVALID");
  return value as Record<string, unknown>;
}
function assertTrustedConnection(services: ToolDispatcherServices): void {
  const result: unknown = services.assertTrustedConnection?.();
  if (result && typeof (result as { then?: unknown }).then === "function") { void Promise.resolve(result).catch(() => undefined); throw new Error("TRUSTED_CONNECTION_REQUIRED"); }
}

/** 命令管线（单事务）：预留→域事务内变体→事件→Outbox→回执。projectId/requestId由可信主体构造，不采信正文。
 * 回执只含合同字段；工具侧附加返回经tool分离（不进入receipt_json）。 */
function runAgentCommand(store: Store, principal: AgentPrincipal, services: ToolDispatcherServices, commandType: string, requestId: string, payload: Record<string, unknown>, execute: (db: WithinDb, commandId: string, requestId: string) => { readonly receipt: Record<string, unknown>; readonly tool: Record<string, unknown> }, replayTool?: (db: WithinDb, commandId: string) => Record<string, unknown>): unknown {
  const now = services.now;
  return store.transaction(db => {
    assertTrustedConnection(services);
    assertAgentPrincipalCurrent(store, principal, now());
    const spec = TOOL_ACTIONS[commandType];
    if (!spec) throw new Error("TOOL_UNKNOWN");
    // 重放也必须使用当前对象范围授权，不能绕过只在首次执行分支中的检查。
    const scope = commandType === "artifact.register" ? { path: payload.kind === "git_commit" ? repositoryScope(String(payload.repositoryPath)) : String(payload.path) }
      : (commandType.startsWith("task.")||commandType==='question.ask'||commandType==='integration.request') && typeof payload.taskId === "string" ? { path: `tasks/${payload.taskId}` }
      : (commandType==='role.provision'||commandType==='handover.prepare')&&typeof payload.roleId==='string'?{path:`roles/${payload.roleId}`}
      : commandType==='handover.verify'&&typeof payload.handoverId==='string'?{path:`handovers/${payload.handoverId}`}
      : (commandType==='integration.evaluate'||commandType==='integration.review')&&typeof payload.integrationId==='string'?{path:`integrations/${payload.integrationId}`}
      : commandType==='question.answer'&&typeof payload.questionId==='string'?{path:`questions/${payload.questionId}`}
      : commandType === "message.ack" && typeof payload.messageId === "string" ? { path: `messages/${payload.messageId}` } : {};
    const decision = authorizeAgentAction(store, principal, services.profileInput, { action: spec.action, targetProjectId: principal.projectId, kind: spec.kind, ...scope }, now());
    if (!decision.allowed) throw new Error(`FORBIDDEN:${decision.reason}`);
    const { reservation, sourcePrincipalId } = reserveAgentOperationWithin(store, principal, commandType,
      commandType === "message.send" || commandType === "task.submit_result" ? payload : { schemaVersion: 2, requestId, projectId: principal.projectId, type: commandType, payload }, now());
    if (reservation.replay) return { ...reservation.receipt, ...(replayTool?.(db, reservation.commandId) ?? {}) };
    const outcome = execute(db, reservation.commandId, requestId);
    commitCommandReceipt(db, sourcePrincipalId, reservation.commandId, outcome.receipt);
    return { ...outcome.receipt, ...outcome.tool };
  });
}

function appendEvent(db: WithinDb, input: { readonly projectId: string; readonly type: string; readonly entityId: string; readonly entityRevision: number; readonly causationId: string; readonly body: Record<string, unknown>; readonly occurredAt: number }): number {
  db.prepare("INSERT INTO events(id,project_id,type,entity_id,entity_revision,causation_id,body_json,occurred_at) VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(), input.projectId, input.type, input.entityId, input.entityRevision, input.causationId, JSON.stringify(input.body), input.occurredAt);
  return Number(db.prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM events WHERE project_id=?").get(input.projectId)?.n);
}

function receipt(input: { requestId: string; projectId: string }, commandId: string, entityType: string, entityId: string, entityRevision: number, lastEventSequence: number): Record<string, unknown> {
  return {
    requestId: input.requestId, projectId: input.projectId, commandId, status: "completed",
    receiptUrl: `/api/v1/commands/${commandId}/receipt`,
    entityIds: [{ localRef: entityId, entityType, id: entityId, revision: entityRevision, version: null }],
    error: null, lastEventSequence,
  };
}

export function createToolDispatcher(store: Store, services: ToolDispatcherServices): (principal: AgentPrincipal, toolName: string, args: unknown) => ToolCallResult {
  const now = services.now;
  const handlers: Readonly<Record<string, ToolHandler>> = {
    'integration.run.read':(store,principal,args)=>store.transaction(()=>{
      assertAgentPrincipalCurrent(store,principal,now());const query=parseContract('query',{schemaVersion:2,type:'integration.run.read',payload:args});if(query.type!=='integration.run.read')throw Error('TOOL_ARGS_INVALID');
      const check:import('./collaboration-workflow.js').Authorize=(action,path,kind)=>{if(!authorizeAgentAction(store,principal,services.profileInput,{action,targetProjectId:principal.projectId,path,kind:kind??'read'},now()).allowed)throw Error('FORBIDDEN');};
      return readIntegrationRunWithin(store,principal.projectId,query.payload.integrationId,query.payload.runId,check);
    }),
    'check.read':(store,principal,args)=>store.transaction(()=>{
      assertAgentPrincipalCurrent(store,principal,now());const query=parseContract('query',{schemaVersion:2,type:'check.read',payload:args});if(query.type!=='check.read')throw Error('TOOL_ARGS_INVALID');
      if(!authorizeAgentAction(store,principal,services.profileInput,{action:'check.read',targetProjectId:principal.projectId,path:`checks/${query.payload.checkId}`,kind:'read'},now()).allowed)throw Error('FORBIDDEN');
      const row=store.db.prepare('SELECT definition_json,enabled FROM check_definitions WHERE project_id=? AND id=? AND version=?').get(principal.projectId,query.payload.checkId,query.payload.version);if(!row)throw Error('CHECK_NOT_FOUND');
      const definition=JSON.parse(String(row.definition_json));if(definition.id!==query.payload.checkId||definition.version!==query.payload.version)throw Error('CHECK_LEGACY_REQUIRES_REPAIR');
      const validated=parseContract('command',{schemaVersion:2,requestId:'read-definition',projectId:principal.projectId,type:'check.register',payload:{definition:{...definition,enabled:row.enabled===1}}});if(validated.type!=='check.register')throw Error('CHECK_LEGACY_REQUIRES_REPAIR');return validated.payload.definition;
    }),
    ...Object.fromEntries(['integration.evaluate','integration.review'].map(type=>[type,(store:Store,principal:AgentPrincipal,args:Record<string,unknown>)=>{
      const {requestId,...payload}=args,command=parseContract('command',{schemaVersion:2,requestId,projectId:principal.projectId,type,payload});
      return runAgentCommand(store,principal,services,type,command.requestId,command.payload,(db,commandId,rid)=>{
        const check=(action:string,path:string,kind:'read'|'write'='read')=>{if(!authorizeAgentAction(store,principal,services.profileInput,{action,targetProjectId:principal.projectId,path,kind},now()).allowed)throw Error('FORBIDDEN');};
        const entity=command.type==='integration.evaluate'?evaluateIntegrationWithin(store,principal,command.payload,commandId,check,now()):command.type==='integration.review'?reviewIntegrationWithin(store,principal,command.payload,commandId,check,now()):(()=>{throw Error('TOOL_ARGS_INVALID');})();
        const seq=appendEvent(db,{projectId:principal.projectId,type,entityId:entity.id,entityRevision:entity.revision,causationId:commandId,body:{entity},occurredAt:now()});return{receipt:receipt({requestId:rid,projectId:principal.projectId},commandId,'integration',entity.id,entity.revision,seq),tool:{entity}};
      },(db,commandId)=>{const event=db.prepare('SELECT body_json FROM events WHERE project_id=? AND causation_id=? AND type=?').get(principal.projectId,commandId,type);if(!event)throw Error('INTEGRATION_REPLAY_SOURCE_MISSING');return{entity:JSON.parse(String(event.body_json)).entity};});
    }])),
    'role.provision':(store,principal,args)=>{
      const {requestId,...payload}=args,command=parseContract('command',{schemaVersion:2,requestId,projectId:principal.projectId,type:'role.provision',payload});if(command.type!=='role.provision')throw Error('TOOL_ARGS_INVALID');
      return runAgentCommand(store,principal,services,command.type,command.requestId,command.payload,(db,commandId,rid)=>{
        if(!authorizeAgentAction(store,principal,services.profileInput,{action:'role.bind',targetProjectId:principal.projectId,kind:'write',path:`roles/${command.payload.roleId}`},now()).allowed)throw Error('FORBIDDEN');
        const operation=queueRoleProvisionWithin(store,principal,command.payload,commandId,now(),(action,path,kind)=>{if(!authorizeAgentAction(store,principal,services.profileInput,{action,targetProjectId:principal.projectId,kind:kind??'read',path},now()).allowed)throw Error('FORBIDDEN');});const seq=appendEvent(db,{projectId:principal.projectId,type:'role.provision.queued',entityId:command.payload.roleId,entityRevision:command.payload.expectedRevision,causationId:commandId,body:operation,occurredAt:now()});
        return {receipt:receipt({requestId:rid,projectId:principal.projectId},commandId,'role',command.payload.roleId,command.payload.expectedRevision,seq),tool:operation};
      },(db,commandId)=>{const op=db.prepare("SELECT id FROM durable_operations WHERE project_id=? AND kind='role.provision' AND json_extract(payload_json,'$.commandId')=?").get(principal.projectId,commandId);if(!op)throw Error('PROVISION_OPERATION_NOT_FOUND');const operation=readOperation(store,String(op.id));return {operationId:op.id,state:operation?.state,steps:operation?.steps};});
    },
    ...Object.fromEntries(['handover.prepare','handover.verify','integration.request'].map(type=>[type,(store:Store,principal:AgentPrincipal,args:Record<string,unknown>)=>{
      const {requestId,...payload}=args,command=parseContract('command',{schemaVersion:2,requestId,projectId:principal.projectId,type,payload});
      return runAgentCommand(store,principal,services,type,command.requestId,command.payload,(db,commandId,rid)=>{
        const check=(action:string,path:string,kind:'read'|'write'='read')=>{if(!authorizeAgentAction(store,principal,services.profileInput,{action,targetProjectId:principal.projectId,path,kind},now()).allowed)throw Error('FORBIDDEN');};
        const entity=command.type==='handover.prepare'?(check(type,`roles/${command.payload.roleId}`,'write'),prepareHandoverWithin(store,principal.projectId,principal.roleId,command.payload,commandId,check))
          :command.type==='handover.verify'?(check(type,`handovers/${command.payload.handoverId}`,'write'),verifyHandoverWithin(store,principal.projectId,principal.roleId,command.payload,check))
          :command.type==='integration.request'?(check(type,`tasks/${command.payload.taskId}`,'write'),requestIntegrationWithin(store,principal.projectId,principal.roleId,command.payload,commandId,check)):(()=>{throw Error('TOOL_ARGS_INVALID');})();
        const seq=appendEvent(db,{projectId:principal.projectId,type,entityId:entity.id,entityRevision:entity.revision,causationId:commandId,body:{entity},occurredAt:now()});
        return {receipt:receipt({requestId:rid,projectId:principal.projectId},commandId,type.startsWith('handover.')?'handover':'integration',entity.id,entity.revision,seq),tool:{entity}};
      },(db,commandId)=>{const row=db.prepare('SELECT body_json FROM events WHERE project_id=? AND causation_id=? AND type=?').get(principal.projectId,commandId,type);if(!row)throw Error('COLLABORATION_RECEIPT_INCOMPLETE');return {entity:JSON.parse(String(row.body_json)).entity};});
    }])),
    ...Object.fromEntries(['handover.read','integration.read'].map(type=>[type,(store:Store,principal:AgentPrincipal,args:Record<string,unknown>)=>store.transaction(()=>{
      assertTrustedConnection(services);assertAgentPrincipalCurrent(store,principal,now());
      const query=parseContract('query',{schemaVersion:2,type,payload:args});const id=query.type==='handover.read'?query.payload.handoverId:query.type==='integration.read'?query.payload.integrationId:'';
      if(!id||!authorizeAgentAction(store,principal,services.profileInput,{action:type,targetProjectId:principal.projectId,kind:'read',path:`${type==='handover.read'?'handovers':'integrations'}/${id}`},now()).allowed)throw Error('FORBIDDEN');
      return type==='handover.read'?handoverContract(store,principal.projectId,id):integrationContract(store,principal.projectId,id);
    })])),
    'question.ask':(store,principal,args)=>{
      const {requestId,...payload}=args,command=parseContract('command',{schemaVersion:2,requestId,projectId:principal.projectId,type:'question.ask',payload});if(command.type!=='question.ask')throw Error('TOOL_ARGS_INVALID');
      return runAgentCommand(store,principal,services,command.type,command.requestId,command.payload,(db,commandId,rid)=>{
        const canNotify=authorizeAgentAction(store,principal,services.profileInput,{action:'message.send',targetProjectId:principal.projectId,kind:'write'},now()).allowed;
        const question=askQuestionWithin(store,principal,command.payload,commandId,services.callerNativeExecutionId,now(),canNotify);
        const seq=appendEvent(db,{projectId:principal.projectId,type:'question.asked',entityId:question.id,entityRevision:question.revision,causationId:commandId,body:{question,notificationRequested:canNotify&&question.answerer.kind==='role'},occurredAt:now()});
        return {receipt:receipt({requestId:rid,projectId:principal.projectId},commandId,'question',question.id,question.revision,seq),tool:{question}};
      },(db,commandId)=>{const event=db.prepare("SELECT body_json FROM events WHERE causation_id=? AND project_id=? AND type='question.asked'").get(commandId,principal.projectId);if(!event)throw Error('QUESTION_RECEIPT_INCOMPLETE');return {question:JSON.parse(String(event.body_json)).question};});
    },
    'question.answer':(store,principal,args)=>{
      const {requestId,...payload}=args,command=parseContract('command',{schemaVersion:2,requestId,projectId:principal.projectId,type:'question.answer',payload});if(command.type!=='question.answer')throw Error('TOOL_ARGS_INVALID');
      return runAgentCommand(store,principal,services,command.type,command.requestId,command.payload,(db,commandId,rid)=>{
        const canNotify=authorizeAgentAction(store,principal,services.profileInput,{action:'message.send',targetProjectId:principal.projectId,kind:'write'},now()).allowed;
        const question=answerQuestionWithin(store,{kind:'bound_agent',roleId:principal.roleId},principal.projectId,command.payload,commandId,now(),canNotify);
        const seq=appendEvent(db,{projectId:principal.projectId,type:'question.answered',entityId:question.id,entityRevision:question.revision,causationId:commandId,body:{question},occurredAt:now()});
        return {receipt:receipt({requestId:rid,projectId:principal.projectId},commandId,'question',question.id,question.revision,seq),tool:{question}};
      },(db,commandId)=>{const event=db.prepare("SELECT body_json FROM events WHERE causation_id=? AND project_id=? AND type='question.answered'").get(commandId,principal.projectId);if(!event)throw Error('QUESTION_RECEIPT_INCOMPLETE');return {question:JSON.parse(String(event.body_json)).question};});
    },
    'question.read':(db,principal,args)=>queryForAgent(db,principal,'question.read',args,now(),()=>assertTrustedConnection(services)),
    'question.list':(db,principal,args)=>queryForAgent(db,principal,'question.list',args,now(),()=>assertTrustedConnection(services)),
    'management.apply_changes':(store,principal,args)=>applyChangesetForAgent(store,principal,{...parseToolArguments('changeset','',args),schemaVersion:2,projectId:principal.projectId},services),
    "task.claim": (store, principal, args) => {
      const { requestId, ...payload } = args;
      const command = parseContract("command", { schemaVersion: 2, requestId, projectId: principal.projectId, type: "task.claim", payload });
      if (command.type !== "task.claim") throw new Error("TOOL_ARGS_INVALID");
      return runAgentCommand(store, principal, services, command.type, command.requestId, command.payload, (db, commandId, rid) => {
        const value = claimTaskWithin(store, principal, command.payload, services.callerNativeExecutionId, now());
        const seq = appendEvent(db, { projectId: principal.projectId, type: "task.claimed", entityId: value.taskId, entityRevision: value.revision, causationId: commandId, body: value, occurredAt: now() });
        return { receipt: receipt({ requestId: rid, projectId: principal.projectId }, commandId, "task", value.taskId, value.revision, seq), tool: value };
      }, (db, commandId) => {
        const event = db.prepare("SELECT body_json FROM events WHERE project_id=? AND causation_id=? AND type='task.claimed'").get(principal.projectId, commandId);
        if (!event) throw new Error("CLAIM_RECEIPT_INCOMPLETE");
        return JSON.parse(String(event.body_json)) as Record<string, unknown>;
      });
    },
    "task.report": (store, principal, args) => {
      const { requestId, ...payload } = args;
      const command = parseContract("command", { schemaVersion: 2, requestId, projectId: principal.projectId, type: "task.report", payload });
      if (command.type !== "task.report") throw new Error("TOOL_ARGS_INVALID");
      return runAgentCommand(store, principal, services, command.type, command.requestId, command.payload, (db, commandId, rid) => {
        if (command.payload.wait?.target.kind === "task") {
          const permission = authorizeAgentAction(store, principal, services.profileInput, { action: "task.read", targetProjectId: principal.projectId, kind: "read", path: `tasks/${command.payload.wait.target.taskId}` }, now());
          if (!permission.allowed) throw new Error("WAIT_TARGET_FORBIDDEN");
        }
        const value = reportTaskWithin(store, principal, command.payload, services.callerNativeExecutionId, commandId, now());
        const seq = appendEvent(db, { projectId: principal.projectId, type: "task.reported", entityId: value.taskId, entityRevision: value.revision, causationId: commandId, body: { reportId: value.reportId, waitId: value.waitId }, occurredAt: now() });
        return { receipt: receipt({ requestId: rid, projectId: principal.projectId }, commandId, "task", value.taskId, value.revision, seq), tool: value };
      });
    },
    "task.accept": (store, principal, args) => {
      const { requestId, ...payload } = args;
      const command = parseContract("command", { schemaVersion: 2, requestId, projectId: principal.projectId, type: "task.accept", payload });
      if (command.type !== "task.accept") throw new Error("TOOL_ARGS_INVALID");
      return runAgentCommand(store, principal, services, command.type, command.requestId, command.payload, (db, commandId, rid) => {
        void db;
        return taskAcceptanceWithin(store, { id: principal.credentialId, kind: "bound_agent", roleId: principal.roleId }, principal.projectId, command.payload, commandId, rid, now(), path => {
          if (!authorizeAgentAction(store, principal, services.profileInput, { action: "artifact.read", targetProjectId: principal.projectId, kind: "read", path }, now()).allowed) throw new Error("ACCEPTANCE_EVIDENCE_FORBIDDEN");
        });
      });
    },
    identity: (_store, principal) => ({ kind: principal.kind, projectId: principal.projectId, roleId: principal.roleId, bindingEpoch: principal.bindingEpoch, credentialId: principal.credentialId, session: principal.session, note: "身份取自连接绑定；不含秘密" }),
    "task.read": (db, principal, args) => queryForAgent(db, principal, "task.read", args, now(), () => assertTrustedConnection(services)),
    "result.read": (db, principal, args) => queryForAgent(db, principal, "result.read", args, now(), () => assertTrustedConnection(services)),
    "task.list": (db, principal, args) => queryForAgent(db, principal, "task.list", args, now(), () => assertTrustedConnection(services)),
    "policy.read": (db, principal, args) => queryForAgent(db, principal, "policy.read", args, now(), () => assertTrustedConnection(services)),
    "project.snapshot": (store,principal,args)=>store.transaction(db=>{
      assertTrustedConnection(services);assertAgentPrincipalCurrent(store,principal,now());const query=parseContract('query',{schemaVersion:2,type:'project.snapshot',payload:{projectId:principal.projectId,...args}});
      if(query.type!=='project.snapshot'||query.payload.projectId!==principal.projectId)throw Error('FORBIDDEN');
      const project=readProject(store,principal.projectId),revisions=db.prepare('SELECT plan_revision,policy_revision,hold_revision FROM projects WHERE id=?').get(principal.projectId);
      const roles=db.prepare('SELECT id,name,desired_state FROM roles WHERE project_id=? ORDER BY id').all(principal.projectId).filter(row=>authorizeAgentAction(store,principal,services.profileInput,{action:'role.read',targetProjectId:principal.projectId,kind:'read',path:`roles/${row.id}`},now()).allowed).map(row=>({roleId:row.id,name:row.name,desiredState:row.desired_state}));
      return {projectId:project.id,objective:project.objective,revision:project.revision,userPaused:project.userPaused,planRevision:revisions?.plan_revision,policyRevision:revisions?.policy_revision,holdRevision:revisions?.hold_revision,eventWatermark:Number(db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM events WHERE project_id=?').get(principal.projectId)?.n),roles};
    }),
    "role.read": (db, principal, args) => queryForAgent(db, principal, "role.read", args, now(), () => assertTrustedConnection(services)),
    "role.list": (db, principal, args) => queryForAgent(db, principal, "role.list", { projectId: principal.projectId, ...args }, now(), () => assertTrustedConnection(services)),
    "inbox.read": (db, principal, args) => queryForAgent(db, principal, "inbox.read", { roleId: principal.roleId, ...args }, now(), () => assertTrustedConnection(services)),
    "message.send": (db, principal, args) => {
      // projectId由主体覆盖；commandId/fromRoleId等非合同字段拒绝。
      const input = parseContract("message", JSON.parse(canonicalJson({ ...args, schemaVersion: 2, projectId: principal.projectId })));
      return runAgentCommand(db, principal, services, "message.send", input.requestId, input, (dw, commandId, rid) => {
        if (input.replyToMessageId && !dw.prepare("SELECT 1 FROM messages WHERE id=? AND project_id=?").get(input.replyToMessageId, principal.projectId)) throw new Error("MESSAGE_REPLY_NOT_FOUND");
        for (const artifact of input.artifacts ?? []) {
          if (!dw.prepare("SELECT 1 FROM artifacts WHERE id=? AND project_id=? AND version=?").get(artifact.artifactId, principal.projectId, artifact.version)) throw new Error("MESSAGE_ARTIFACT_NOT_FOUND");
        }
        const record = sendMessageWithin(dw, { id: `msg-${randomUUID()}`, projectId: principal.projectId, commandId, toRoleId: input.toRoleId, kind: input.kind, body: input.body, ...(input.taskId ? { taskId: input.taskId } : {}) }, now());
        // 只确认持久保存，不伪报原生送达或业务完成。
        dw.prepare("UPDATE messages SET delivery_json=? WHERE id=? AND project_id=?").run(canonicalJson({ delivery: input.delivery, replyToMessageId: input.replyToMessageId ?? null, artifacts: input.artifacts ?? [], fromRoleId: principal.roleId, bindingEpoch: principal.bindingEpoch, transitions: [{ state: "stored", at: now() }] }), record.id, principal.projectId);
        const seq = appendEvent(dw, { projectId: principal.projectId, type: "message.stored", entityId: record.id, entityRevision: 1, causationId: commandId, body: { messageId: record.id, fromRoleId: principal.roleId, toRoleId: record.toRoleId }, occurredAt: now() });
        return { receipt: receipt({ requestId: rid, projectId: principal.projectId }, commandId, "message", record.id, 1, seq), tool: { messageId: record.id, toRoleId: record.toRoleId, state: record.state } };
      });
    },
    // 命令管线（message.ack合同载荷：messageId+state+bindingEpoch）：确认者=principal.roleId、代次=主体绑定实时校验（正文不可指定）
    "message.ack": (db, principal, args) => {
      requireArgs(args, ["messageId"]);
      const messageId = String(args.messageId);
      const rawState = args.state === undefined ? "acknowledged" : String(args.state);
      if (rawState !== "acknowledged" && rawState !== "resolved") throw new Error("TOOL_ARGS_INVALID:state");
      const requestId = typeof args.requestId === "string" && args.requestId.length >= 1 && args.requestId.length <= 128 ? args.requestId : `tool-ack-${randomUUID()}`;
      return runAgentCommand(db, principal, services, "message.ack", requestId, { messageId, state: rawState, bindingEpoch: principal.bindingEpoch }, (dw, commandId, rid) => {
        const binding = dw.prepare("SELECT b.epoch AS epoch FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.project_id=? AND b.role_id=? AND s.harness_id=? AND s.host_id=? AND s.profile_id=? AND s.native_conversation_id=?").get(principal.projectId, principal.roleId, principal.session.harnessId, principal.session.hostId, principal.session.profileId, principal.session.nativeConversationId) as { epoch: number } | undefined;
        if (!binding || Number(binding.epoch) !== principal.bindingEpoch) throw new Error("BINDING_STALE");
        const record = rawState === "resolved" ? resolveMessageWithin(dw, principal.projectId, messageId, principal.roleId, now()) : acknowledgeMessageWithin(dw, principal.projectId, messageId, principal.roleId, now());
        const seq = appendEvent(dw, { projectId: principal.projectId, type: `message.${rawState}`, entityId: messageId, entityRevision: 1, causationId: commandId, body: { messageId, roleId: principal.roleId, bindingEpoch: principal.bindingEpoch }, occurredAt: now() });
        return {
          receipt: receipt({ requestId: rid, projectId: principal.projectId }, commandId, "message", messageId, 1, seq),
          tool: { messageId: record.id, state: record.state },
        };
      });
    },
    // 命令管线（artifact.register合同载荷file/report|git_commit）：版本取内容锚（sha256/commitId）；projectId取主体
    "artifact.register": (db, principal, args) => {
      requireArgs(args, ["taskId", "kind"]);
      const kind = String(args.kind);
      const taskId = String(args.taskId);
      const requestId = typeof args.requestId === "string" && args.requestId.length >= 1 && args.requestId.length <= 128 ? args.requestId : `tool-art-${randomUUID()}`;
      let pathRef: string; let version: string; let sha256: string | null = null; let byteSize: number | null = null; let payload: Record<string, unknown>;
      if (kind === "git_commit") {
        requireArgs(args, ["repositoryPath", "commitId", "taskRevision"]);
        const commitId = String(args.commitId);
        pathRef = `git:${commitId}`; version = commitId; payload = { taskId, kind, repositoryPath: String(args.repositoryPath), commitId, taskRevision: Number(args.taskRevision) };
      } else if (kind === "file" || kind === "report") {
        requireArgs(args, ["path", "sha256", "byteSize", "taskRevision"]);
        sha256 = String(args.sha256); byteSize = Number(args.byteSize);
        pathRef = String(args.path); version = sha256; payload = { taskId, kind, path: pathRef, sha256, byteSize, taskRevision: Number(args.taskRevision) };
      } else throw new Error("TOOL_ARGS_INVALID:kind");
      return runAgentCommand(db, principal, services, "artifact.register", requestId, payload, (dw, commandId, rid) => {
        const task = dw.prepare("SELECT role_id,spec_revision FROM tasks WHERE id=? AND project_id=?").get(taskId, principal.projectId);
        if (!task || task.role_id !== principal.roleId) throw new Error("ARTIFACT_TASK_NOT_OWNED");
        if (task.spec_revision !== payload.taskRevision) throw new Error("ARTIFACT_TASK_REVISION_STALE");
        if(kind!=='git_commit')assertAgentArtifactFile(db,principal.projectId,pathRef,String(sha256),Number(byteSize),path=>{
          if(!authorizeAgentAction(db,principal,services.profileInput,{action:'artifact.register_own',targetProjectId:principal.projectId,kind:'write',path},now()).allowed)throw Error('FORBIDDEN');
        });
        const id = `art-${randomUUID()}`;
        const record = kind === "git_commit" ? registerGitArtifactWithin(db, { id, projectId: principal.projectId, taskId, taskRevision: payload.taskRevision, repositoryPath: String(payload.repositoryPath), revision: version }, now(), path => {
          if (!authorizeAgentAction(db, principal, services.profileInput, { action: "artifact.register_own", targetProjectId: principal.projectId, kind: "write", path }, now()).allowed) throw new Error("FORBIDDEN");
        }) : registerArtifactWithin(dw, { id, projectId: principal.projectId, taskId, taskRevision: payload.taskRevision, version, pathRef, sha256, byteSize }, now());
        const seq = appendEvent(dw, { projectId: principal.projectId, type: "artifact.registered", entityId: record.id, entityRevision: 1, causationId: commandId, body: { artifactId: record.id, taskId, kind, pathRef, taskRevision: payload.taskRevision }, occurredAt: now() });
        return {
          receipt: receipt({ requestId: rid, projectId: principal.projectId }, commandId, "artifact", record.id, 1, seq),
          tool: { artifactId: record.id, version: record.version, pathRef: record.pathRef },
        };
      });
    },
    "artifact.read": (db, principal, args) => {
      requireArgs(args, ["artifactId"]);
      const record = readArtifactRecord(db, principal.projectId, String(args.artifactId));
      if (record.taskId !== null && !authorizeAgentAction(db, principal, services.profileInput, { action: "task.read", targetProjectId: principal.projectId, kind: "read", path: `tasks/${record.taskId}` }, now()).allowed) throw new Error("ARTIFACT_NOT_FOUND");
      if (record.pathRef.startsWith("git:")) {
        return db.transaction(() => {
          assertTrustedConnection(services); assertAgentPrincipalCurrent(db, principal, now());
          const verified = assertGitArtifactSource(db, principal.projectId, record.id, path => {
            if (!authorizeAgentAction(db, principal, services.profileInput, { action: "artifact.read", targetProjectId: principal.projectId, kind: "read", path }, now()).allowed) throw new Error("ARTIFACT_NOT_FOUND");
          });
          return { artifactId: record.id, version: record.version, pathRef: record.pathRef, repositoryPath: verified.repositoryPath, commit: verified.evidence, treeSha: verified.treeSha, note: "已核对登记仓库与提交对象，不代表已整合或通过项目验收" };
        });
      }
      if (!authorizeAgentAction(db, principal, services.profileInput, { action: "artifact.read", targetProjectId: principal.projectId, kind: "read", path: record.pathRef }, now()).allowed) throw new Error("ARTIFACT_NOT_FOUND");
      const boundary = resolveWithinProject(readProject(db, principal.projectId).canonicalRoot, record.pathRef);
      void boundary;
      return { artifactId: record.id, version: record.version, pathRef: record.pathRef, sha256: record.sha256, byteSize: record.byteSize, note: "内容读取需在项目根上下文中执行（resolveWithinProject边界）；本派发器返回登记元数据" };
    },
    "artifact.content": (db, principal, args) => artifactContentForAgent(db, principal, args, now(), () => assertTrustedConnection(services)),
    // 结果流程（result.schema.json）：任务/尝试/版本绑定由域层校验；执行者身份经授权主体
    "task.submit_result": (db, principal, args) => {
      const input = parseContract("result", JSON.parse(canonicalJson({ ...args, schemaVersion: 2, projectId: principal.projectId })));
      if (input.bindingEpoch !== principal.bindingEpoch) throw new Error("RESULT_BINDING_STALE");
      return runAgentCommand(db, principal, services, "task.submit_result", input.requestId, input, (dw, commandId, rid) => {
        const attempt = dw.prepare("SELECT binding_id,binding_epoch FROM attempts WHERE id=? AND project_id=? AND task_id=? AND task_revision=?").get(input.attemptId, principal.projectId, input.taskId, input.taskRevision);
        if (!attempt) throw new Error("RESULT_ATTEMPT_NOT_FOUND");
        if (attempt.binding_id !== principal.bindingId || attempt.binding_epoch !== principal.bindingEpoch) throw new Error("RESULT_ATTEMPT_NOT_OWNED");
        const task = dw.prepare("SELECT role_id,spec_revision,state,revision FROM tasks WHERE id=? AND project_id=?").get(input.taskId, principal.projectId);
        if (!task || task.role_id !== principal.roleId) throw new Error("RESULT_TASK_NOT_OWNED");
        if (task.spec_revision === input.taskRevision && ["accepted", "cancelled"].includes(String(task.state))) throw new Error("RESULT_TASK_FINISHED");
        if (input.outcome === "succeeded" && dw.prepare("SELECT 1 FROM waits WHERE project_id=? AND attempt_id=? AND state='waiting'").get(principal.projectId, input.attemptId)) throw new Error("RESULT_WAIT_UNRESOLVED");
        for (const output of input.outputs) {
          if (!dw.prepare("SELECT 1 FROM artifacts WHERE id=? AND project_id=? AND task_id=? AND task_revision=? AND version=?").get(output.artifactId, principal.projectId, input.taskId, input.taskRevision, output.version)) throw new Error("RESULT_OUTPUT_NOT_FOUND");
          const artifact=readArtifactRecord(db,principal.projectId,output.artifactId);
          if(!artifact.pathRef.startsWith('git:')){
            if(!authorizeAgentAction(db,principal,services.profileInput,{action:'task.submit_own',targetProjectId:principal.projectId,kind:'write',path:artifact.pathRef},now()).allowed)throw Error('FORBIDDEN');
            if(artifact.sha256===null||artifact.byteSize===null)throw Error('RESULT_OUTPUT_FILE_METADATA_REQUIRED');
            assertAgentArtifactFile(db,principal.projectId,artifact.pathRef,artifact.sha256,artifact.byteSize,path=>{
              if(!authorizeAgentAction(db,principal,services.profileInput,{action:'task.submit_own',targetProjectId:principal.projectId,kind:'write',path},now()).allowed)throw Error('FORBIDDEN');
            });
          }
        }
        for (const check of input.checks) {
          if (!dw.prepare("SELECT 1 FROM artifacts WHERE id=? AND project_id=? AND task_id=?").get(check.evidenceArtifactId, principal.projectId, input.taskId)) throw new Error("RESULT_CHECK_EVIDENCE_NOT_FOUND");
        }
        const view = submitResultWithin(dw, { id: `res-${randomUUID()}`, ...input }, now());
        let seq = appendEvent(dw, { projectId: principal.projectId, type: "result.submitted", entityId: view.id, entityRevision: 1, causationId: commandId, body: { resultId: view.id, taskId: view.taskId, attemptId: input.attemptId, bindingEpoch: principal.bindingEpoch }, occurredAt: now() });
        if (view.eligibility === "current") {
          dw.prepare("UPDATE tasks SET state='review',revision=revision+1 WHERE id=? AND project_id=?").run(input.taskId, principal.projectId);
          seq = appendEvent(dw, { projectId: principal.projectId, type: "task.result_reported", entityId: input.taskId, entityRevision: Number(task.revision) + 1, causationId: commandId, body: { resultId: view.id, outcome: input.outcome }, occurredAt: now() });
        }
        return { receipt: receipt({ requestId: rid, projectId: principal.projectId }, commandId, "result", view.id, 1, seq), tool: { resultId: view.id, taskId: view.taskId, taskRevision: view.taskRevision, outcome: view.outcome, eligibility: view.eligibility } };
      });
    },
    // 命令管线（issue.raise合同载荷：taskId+category+summary+evidenceArtifactIds）：owner=principal.roleId；指纹由category+summary稳定导出供合并
    "issue.raise": (db, principal, args) => {
      requireArgs(args, ["taskId", "category", "summary"]);
      const category = String(args.category);
      const summary = String(args.summary);
      const evidenceArtifactIds = args.evidenceArtifactIds === undefined ? [] : args.evidenceArtifactIds;
      if (!Array.isArray(evidenceArtifactIds) || evidenceArtifactIds.some(id => typeof id !== "string")) throw new Error("TOOL_ARGS_INVALID:evidenceArtifactIds");
      const requestId = typeof args.requestId === "string" && args.requestId.length >= 1 && args.requestId.length <= 128 ? args.requestId : `tool-case-${randomUUID()}`;
      const payload = { taskId: String(args.taskId), category, summary, evidenceArtifactIds };
      return runAgentCommand(db, principal, services, "issue.raise", requestId, payload, (dw, commandId, rid) => {
        const caseId = `case-${randomUUID()}`;
        const fingerprint = createHash("sha256").update(canonicalJson({ category, summary })).digest("hex").slice(0, 64);
        const result = raiseIssueWithin(dw, { id: caseId, projectId: principal.projectId, taskId: payload.taskId, ownerRoleId: principal.roleId, fingerprint, evidence: { category, summary, evidenceArtifactIds } }, now());
        const seq = appendEvent(dw, { projectId: principal.projectId, type: "issue.raised", entityId: result.caseView.id, entityRevision: result.caseView.revision, causationId: commandId, body: { caseId: result.caseView.id, merged: result.merged, category }, occurredAt: now() });
        enqueueOutbox(dw, { id: randomUUID(), commandId, operationKey: `issue.raised:${principal.projectId}:${result.caseView.id}:${result.caseView.revision}`, payload: { event: "issue.raised", projectId: principal.projectId, caseId: result.caseView.id }, nextAttemptAt: now() });
        return {
          receipt: receipt({ requestId: rid, projectId: principal.projectId }, commandId, "case", result.caseView.id, result.caseView.revision, seq),
          tool: { caseId: result.caseView.id, merged: result.merged },
        };
      });
    },
    // 命令管线（role.startup_ack合同载荷）：roleId/bindingEpoch强制取主体；六类版本门槛在域层核验
    "role.startup_ack": (db, principal, args) => {
      requireArgs(args, ["protocolVersion", "policyRevision", "planRevision", "roleRevision"]);
      const taskSpecRevisions = args.taskSpecRevisions === undefined ? [] : args.taskSpecRevisions;
      if (!Array.isArray(taskSpecRevisions) || taskSpecRevisions.some(e => !e || typeof e !== "object" || typeof (e as Record<string, unknown>).taskId !== "string" || typeof (e as Record<string, unknown>).specRevision !== "number")) throw new Error("TOOL_ARGS_INVALID:taskSpecRevisions");
      const requestId = typeof args.requestId === "string" && args.requestId.length >= 1 && args.requestId.length <= 128 ? args.requestId : `tool-sack-${randomUUID()}`;
      const payload = { roleId: principal.roleId, bindingEpoch: principal.bindingEpoch, protocolVersion: Number(args.protocolVersion), policyRevision: Number(args.policyRevision), planRevision: Number(args.planRevision), roleRevision: Number(args.roleRevision), taskSpecRevisions };
      return runAgentCommand(db, principal, services, "role.startup_ack", requestId, payload, (dw, commandId, rid) => {
        const role = completeStartupAckWithin(dw, { projectId: principal.projectId, roleId: principal.roleId, bindingEpoch: principal.bindingEpoch, protocolVersion: payload.protocolVersion, policyRevision: payload.policyRevision, planRevision: payload.planRevision, roleRevision: payload.roleRevision, taskSpecRevisions: payload.taskSpecRevisions as { taskId: string; specRevision: number }[] }, now());
        const seq = appendEvent(dw, { projectId: principal.projectId, type: "role.startup_acknowledged", entityId: role.id, entityRevision: role.revision, causationId: commandId, body: { roleId: role.id, bindingEpoch: principal.bindingEpoch, bindingState: role.bindingState }, occurredAt: now() });
        return {
          receipt: receipt({ requestId: rid, projectId: principal.projectId }, commandId, "role", role.id, role.revision, seq),
          tool: { roleId: role.id, bindingState: role.bindingState, revision: role.revision },
        };
      });
    },
    "issue.read": (db, principal, args) => {
      if (args.caseId !== undefined) {
        const row = db.db.prepare("SELECT id,project_id,task_id,owner_role_id,fingerprint,state,revision,evidence_json FROM cases WHERE id=? AND project_id=?").get(String(args.caseId), principal.projectId) as Record<string, unknown> | undefined;
        if (!row) throw new Error("CASE_NOT_FOUND");
        return { caseId: String(row.id), taskId: row.task_id === null ? null : String(row.task_id), ownerRoleId: row.owner_role_id === null ? null : String(row.owner_role_id), fingerprint: String(row.fingerprint), state: String(row.state), revision: Number(row.revision), evidence: JSON.parse(String(row.evidence_json)) };
      }
      return { projectId: principal.projectId, openIssues: listOpenIssues(db, principal.projectId) };
    },
  };

  return (principal, toolName, args) => {
    const mapped = TOOL_ACTIONS[toolName];
    const pending = PENDING_TOOL_ACTIONS[toolName];
    if (!mapped && !pending) return { tool: toolName, ok: false, payload: { error: "TOOL_UNKNOWN" } };
    // T023闭环：原生调用来源必须与凭据绑定会话一致（同进程跨线程共享凭据在派发点被拒）
    try {
      assertTrustedConnection(services);
      assertAgentPrincipalCurrent(store, principal, now());
    } catch {
      return { tool: toolName, ok: false, payload: { error: "AGENT_UNAUTHENTICATED" } };
    }
    if (!services.callerNativeConversationId || services.callerNativeConversationId !== principal.session.nativeConversationId) {
      return { tool: toolName, ok: false, payload: { error: "FORBIDDEN", reason: "CALLER_SESSION_MISMATCH" } };
    }
    // 每次调用实时授权：主体状态+档案动作+项目隔离+暂停+路径范围（正文不参与身份判定）
    const spec: ToolActionSpec = (mapped ?? pending) as ToolActionSpec;
    let decision: ReturnType<typeof authorizeAgentAction>;
    try {
      decision = authorizeAgentAction(store, principal, services.profileInput, { action: spec.action, targetProjectId: principal.projectId, kind: spec.kind }, now());
    } catch {
      return { tool: toolName, ok: false, payload: { error: "FORBIDDEN", reason: "POLICY_SUBJECT_NOT_ACTIVE" } };
    }
    if (!decision.allowed) return { tool: toolName, ok: false, payload: { error: "FORBIDDEN", reason: decision.reason } };
    if (pending) return { tool: toolName, ok: false, payload: { error: "CAPABILITY_UNSUPPORTED", note: "域处理器属正式任务范围（T028/T030/T033）" } };
    const handler = handlers[toolName];
    if (!handler) return { tool: toolName, ok: false, payload: { error: "CAPABILITY_UNSUPPORTED" } };
    try {
      const payload = handler(store, principal, asRecord(args));
      return { tool: toolName, ok: true, payload };
    } catch (error) {
      return { tool: toolName, ok: false, payload: { error: String((error as Error)?.message ?? error).slice(0, 200) } };
    }
  };
}

export function readRoleForPrincipal(store: Store, principal: AgentPrincipal) {
  return readRole(store, principal.projectId, principal.roleId);
}

import {safeExecutionDiagnostic,type ExecutionDiagnostic} from '../native/execution-diagnostics.js';
/** DR02第二段（场景一）：消息真实投递泵。queued消息→目标绑定的原生会话真实跑一轮→
 * 依回执结算 delivered/failed/uncertain——绝不把排队当送达、绝不伪造delivered。
 * 回执（含原生助手回复原文）写入messages.delivery_json并可经durable_operations步骤查询。
 * 泵为纯编排：原生执行经注入的runInBinding（生产=ZCodeTextProcess resume路径/Codex适配器）。 */
import {reserveNativeWriteWithin,assertNativeWriteWithin,assertNativeWriteIdentityWithin,activateNativeWriteWithin,finishNativeWriteWithin,type NativeWriteProof} from "@projectorch/domain/workspaces";
import type { Store } from "@projectorch/persistence";
import { dispatchQueuedForEnabledRoles, claimForSending, markDelivered, markDeliveryFailed, markUncertainDelivery, markNativeSessionVerified } from "@projectorch/domain/messages";
import { NativeRpcError } from "../native/stdio-peer.js";
import { recordStep } from "../tools/orchestration-tools.js";
import { readProjectPolicy } from '../auth/project-policy.js';
import {unresolvedFactoryCapacity} from './native-capacity.js';

/** 原生轮次回执（由注入的执行器如实报告——成功判据以回执为准，不以输入回显为准）。 */
export interface NativeTurnReceipt {
  readonly diagnostics?:ExecutionDiagnostic;
  readonly harnessId: string;
  readonly nativeConversationId: string;
  readonly nativeTurnId: string | null;
  readonly status: "completed" | "failed" | "unknown";
  /** 原生助手回复原文（completed时；失败/unknown为空串）。 */
  readonly responseText: string;
  readonly exitConfirmed: boolean;
  readonly failureCode?: string;
}

export interface DeliveryTarget {
  readonly harnessId: string;
  readonly nativeConversationId: string;
  readonly workspaceRoot: string;
  readonly hostId?: string;
  readonly profileId?: string;
  readonly nativeWorkspaceId?: string;
}

export interface MessageDeliveryServices {
  readonly now: () => number;
  /** 在目标绑定的原生会话里以input真实跑一轮。确定性未执行（未配置/参数非法）抛错→failed；
   * 外发后无可靠回执→resolve为status:'unknown'→uncertain。 */
  readonly runInBinding: (bindingId: string, target: DeliveryTarget, input: string, assertCurrent: () => void, onTurnStarted: (harnessId:string,nativeConversationId:string,nativeTurnId:string)=>void) => Promise<NativeTurnReceipt>;
  /** 受信应用的owner/授权检查。须同步；每次外发前及结算前重验。 */
  readonly assertOwner?: () => void;
  readonly assertSenderAuthorized?: (messageId: string) => void;
  /** 复核批次一：官方会话观察核验（adopt来源verified_origin=0在投递前经官方resume/read确认）——true=通过（泵标记verified继续）；false=未通过（消息保持queued不盲发）。 */
  readonly officialObserve?: (target: DeliveryTarget) => Promise<boolean>;
}

export interface MessagePumpOptions {
  /** 单次pump最多处理的候选消息数。 */
  readonly maxPerPump?: number;
}

export interface MessagePumpResult {
  readonly dispatched: number;
  readonly attempted: number;
  readonly delivered: number;
  readonly failed: number;
  readonly uncertain: number;
  readonly skipped: number;
}

interface CandidateRow {
  readonly id: string;
  readonly project_id: string;
  readonly to_role_id: string;
  readonly body: string;
  readonly binding_id: string;
  readonly harness_id: string;
  readonly native_conversation_id: string;
  readonly native_workspace_id: string;
  readonly host_id: string;
  readonly profile_id: string;
  readonly operation_id: string | null;
  readonly binding_epoch: number;
  readonly role_revision: number;
  readonly model_revision:number;
  readonly policy_revision: number;
  readonly hold_revision: number;
}

const DEFAULT_MAX_PER_PUMP = 8;
const REPLY_EXCERPT_MAX = 4000;

/** 并发防护：同store同时只有一个泵在跑（跨store互不影响）。 */
const pumpingStores = new WeakSet<object>();

export async function pumpMessageDelivery(store: Store, services: MessageDeliveryServices, options: MessagePumpOptions = {}): Promise<MessagePumpResult> {
  const maxPerPump = options.maxPerPump ?? DEFAULT_MAX_PER_PUMP;
  if (!Number.isSafeInteger(maxPerPump) || maxPerPump < 1 || maxPerPump > 200) throw new Error("INVALID_MAX_PER_PUMP");
  if (pumpingStores.has(store)) return { dispatched: 0, attempted: 0, delivered: 0, failed: 0, uncertain: 0, skipped: 0 };
  pumpingStores.add(store);
  const result: { dispatched: number; attempted: number; delivered: number; failed: number; uncertain: number; skipped: number } = { dispatched: 0, attempted: 0, delivered: 0, failed: 0, uncertain: 0, skipped: 0 };
  try {
    const now0 = services.now();
    // 先放行：启用角色的stored→queued（停用角色保持stored可追踪）
    const storedProjects = store.db.prepare("SELECT DISTINCT m.project_id AS project_id FROM messages m JOIN projects p ON p.id=m.project_id AND p.user_paused=0 WHERE m.state='stored'").all() as { project_id: string }[];
    for (const row of storedProjects) {
      const { dispatched } = dispatchQueuedForEnabledRoles(store, String(row.project_id), now0);
      result.dispatched += dispatched;
    }
    // 候选：queued + 角色启用 + 绑定ready + 未结束绑定（provisioning绑定不可投递——先完成握手）
    // 复核修复：项目用户暂停（projects.user_paused）时一律不外发——消息/任务共用项目暂停栅栏
    const rows = store.db.prepare(`SELECT m.id AS id, m.project_id AS project_id, m.to_role_id AS to_role_id, m.body AS body, b.id AS binding_id, b.epoch AS binding_epoch, r.revision AS role_revision,r.model_preference_revision AS model_revision, p.policy_revision AS policy_revision, p.hold_revision AS hold_revision, s.harness_id AS harness_id, s.host_id AS host_id, s.profile_id AS profile_id, s.native_conversation_id AS native_conversation_id, s.native_workspace_id AS native_workspace_id, c.request_id AS operation_id
      FROM messages m
      JOIN roles r ON r.id=m.to_role_id AND r.project_id=m.project_id
      JOIN projects p ON p.id=m.project_id AND p.user_paused=0
      JOIN role_bindings b ON b.role_id=m.to_role_id AND b.project_id=m.project_id AND b.ended_at IS NULL
      JOIN sessions s ON s.id=b.session_id
      LEFT JOIN commands c ON c.id=m.command_id
      WHERE m.state='queued' AND r.desired_state='enabled' AND r.binding_state='ready'
      ORDER BY m.created_at, m.id LIMIT ?`).all(maxPerPump) as unknown as CandidateRow[];
    for (const row of rows) {
      const message = String(row.id);
      const projectId = String(row.project_id);
      const operationId = row.operation_id === null ? null : String(row.operation_id);
      const target: DeliveryTarget = { harnessId: String(row.harness_id), hostId:row.host_id,profileId:row.profile_id,nativeConversationId: String(row.native_conversation_id), nativeWorkspaceId:row.native_workspace_id,workspaceRoot: String(row.native_workspace_id ?? "") };
      let writeProof:NativeWriteProof|undefined;
      const settleWrite=(outcome:'not_sent'|'terminal'|'unknown',evidence:Record<string,unknown>)=>()=>{if(writeProof)finishNativeWriteWithin(store,writeProof,outcome,{...evidence,sourceId:message},services.now());};
      const assertCurrent = (): void => {
       const recheck=()=>{
        services.assertOwner?.();
        services.assertSenderAuthorized?.(message);
        const current = store.db.prepare(`SELECT 1 FROM messages m
          JOIN projects p ON p.id=m.project_id AND p.user_paused=0
          JOIN roles r ON r.id=m.to_role_id AND r.project_id=m.project_id AND r.desired_state='enabled' AND r.binding_state='ready'
          JOIN role_bindings b ON b.id=? AND b.role_id=r.id AND b.project_id=p.id AND b.ended_at IS NULL
          JOIN sessions s ON s.id=b.session_id
          WHERE m.id=? AND m.state IN ('queued','sending') AND b.epoch=? AND r.revision=? AND r.model_preference_revision=?
          AND p.policy_revision=? AND p.hold_revision=? AND s.harness_id=? AND s.native_conversation_id=?
          AND NOT EXISTS(SELECT 1 FROM goal_holds h WHERE h.project_id=p.id AND h.state IN ('pending','awaiting_user'))
          AND NOT EXISTS(SELECT 1 FROM attempts a WHERE a.binding_id=b.id AND a.state IN ('dispatching','running','waiting_input','unknown'))`).get(row.binding_id, message, row.binding_epoch, row.role_revision,row.model_revision, row.policy_revision, row.hold_revision, target.harnessId, target.nativeConversationId);
        if (!current) throw new NativeRpcError('MESSAGE_ADMISSION_CHANGED', 'not_sent');
        {
          const policy = readProjectPolicy(store.db,projectId);
          if(policy.nativeMode!=='verified_only')throw new NativeRpcError('NATIVE_EXECUTION_DISABLED','not_sent');
          if(policy.limits.costCeiling!==null)throw new NativeRpcError('COST_ENFORCEMENT_UNAVAILABLE','not_sent');
          const factories=unresolvedFactoryCapacity(store.db,projectId,String(row.to_role_id));
          const attemptCount = Number(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE project_id=? AND state IN ('dispatching','running','waiting_input','unknown')").get(projectId)?.n);
          const messageCount = Number(store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE project_id=? AND id<>? AND state IN ('sending','uncertain')").get(projectId,message)?.n);
          const roleAttempts=Number(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE project_id=? AND binding_id=? AND state IN ('dispatching','running','waiting_input','unknown')").get(projectId,row.binding_id)?.n);
          const roleMessages=Number(store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE project_id=? AND to_role_id=? AND id<>? AND state IN ('sending','uncertain')").get(projectId,row.to_role_id,message)?.n);
          if (attemptCount + messageCount+factories.total >= policy.limits.totalConcurrency || roleAttempts+roleMessages+factories.role>=policy.limits.roleConcurrency) throw new NativeRpcError('MESSAGE_CONCURRENCY_EXCEEDED','not_sent');
        }
        if(writeProof)try{assertNativeWriteWithin(store,writeProof);}catch{throw new NativeRpcError('MESSAGE_WRITE_RESERVATION_CHANGED','not_sent');}
       };
       if(store.db.isTransaction)recheck();else store.transaction(recheck);
      };
      const step = (state: "observed" | "unknown" | "failed", detail: string): void => { if (operationId) { try { recordStep(store, operationId, { step: "deliver-turn", state, detail, at: services.now() }, services.now()); } catch { /* 操作缺失不阻断结算 */ } } };
      // 复核批次一：adopt来源未核验会话——claim前经官方观察核验（官方resume/read确认会话真实存在），失败保持queued可重试
      const unverified = store.db.prepare("SELECT 1 FROM sessions WHERE harness_id=? AND native_conversation_id=? AND verified_origin=0").get(target.harnessId, target.nativeConversationId);
      if (unverified) {
        let verifiedNow = false;
        try { verifiedNow = services.officialObserve ? await services.officialObserve(target) : false; } catch { verifiedNow = false; }
        if (!verifiedNow) { step("unknown", "ADOPTION_VERIFICATION_PENDING（官方观察未通过/未注入——保持queued不盲发）"); result.skipped += 1; continue; }
        markNativeSessionVerified(store, target);
        step("observed", "adoption-verification:官方会话观察核验通过");
      }
      try {
        claimForSending(store, projectId, message, services.now(), ()=>{
          assertCurrent();
          writeProof=reserveNativeWriteWithin(store,{projectId,roleId:String(row.to_role_id),kind:'message',sourceId:message,targetRoot:target.workspaceRoot,bindingId:String(row.binding_id),bindingEpoch:Number(row.binding_epoch)},services.now());
          activateNativeWriteWithin(store,writeProof,'message',services.now());
        });
      } catch(error) {
        const code=String((error as Error)?.message??'MESSAGE_ADMISSION_REJECTED');
        if(/^(NATIVE_WRITE_|ENOENT)/.test(code))step('failed','MESSAGE_WRITE_SCOPE_BLOCKED（保持queued，不启动模型）');
        result.skipped += 1; // 已被并发领取或状态不符
        continue;
      }
      result.attempted += 1;
      let startFrameSeen=false,observationFailed=false,observedStart:{harnessId:string;nativeConversationId:string;nativeTurnId:string}|null=null;
      const onTurnStarted=(harnessId:string,nativeConversationId:string,nativeTurnId:string)=>{
        startFrameSeen=true;try{services.assertOwner?.();
        if(harnessId!==target.harnessId||nativeConversationId!==target.nativeConversationId||typeof nativeTurnId!=='string'||!nativeTurnId||nativeTurnId.length>512)throw Error('MESSAGE_NATIVE_START_TARGET_MISMATCH');
        const metadata={harnessId,nativeConversationId,nativeTurnId};
        store.transaction(()=>{
          if(!writeProof)throw Error('MESSAGE_WRITE_PROOF_REQUIRED');
          const effect=assertNativeWriteIdentityWithin(store,writeProof),previous=effect.evidence_json?JSON.parse(String(effect.evidence_json)):{};
          if(previous.receipt?.nativeTurnId&&previous.receipt.nativeTurnId!==nativeTurnId)throw Error('MESSAGE_NATIVE_START_CHANGED');
          const current=store.db.prepare("SELECT delivery_json FROM messages WHERE id=? AND project_id=? AND state='sending'").get(message,projectId);if(!current)throw Error('MESSAGE_NATIVE_START_STALE');
          const delivery=JSON.parse(String(current.delivery_json)),at=services.now();delivery.transitions.push({state:'sending',at,receipt:{...metadata,nativeStartObserved:true,exitConfirmed:false}});
          store.db.prepare('UPDATE native_write_effects SET evidence_json=?,updated_at=? WHERE id=? AND owner_key=? AND fence=?').run(JSON.stringify({...previous,sourceId:message,receipt:{...previous.receipt,...metadata,status:'unknown',exitConfirmed:false},nativeStartObserved:true}),at,writeProof.id,writeProof.ownerKey,writeProof.fence);
          store.db.prepare("UPDATE messages SET delivery_json=? WHERE id=? AND project_id=? AND state='sending'").run(JSON.stringify(delivery),message,projectId);
        });observedStart=metadata;
        }catch(error){observationFailed=true;throw error;}
      };
      let receipt: NativeTurnReceipt;
      try {
        assertCurrent();
        receipt = await services.runInBinding(String(row.binding_id), target, String(row.body), assertCurrent,onTurnStarted);
        if(receipt.diagnostics)receipt={...receipt,diagnostics:safeExecutionDiagnostic(receipt.diagnostics)};
      } catch (error) {
        // 复核修复：异常分类结算——确定性未发出（NativeRpcError delivery=not_sent：配置缺失/参数非法/发送前拒绝）才failed；
        // 外发后状态未知（uncertain/rejected/未分类异常）一律uncertain，不伪装failed也不推断已执行。
        const notSent = error instanceof NativeRpcError && error.delivery === "not_sent"&&!startFrameSeen;
        const failureCode = notSent ? `NOT_SENT:${(error as Error).message.slice(0, 120)}` : `SEND_RESULT_UNKNOWN:${(error as Error).constructor.name}`;
        if (notSent) {
          markDeliveryFailed(store, projectId, message, { failureCode }, services.now(),settleWrite('not_sent',{notSent:true,failureCode}));
          step("failed", failureCode);
          result.failed += 1;
        } else {
          const metadata=observedStart??{};
          markUncertainDelivery(store, projectId, message, { ...metadata,failureCode, exitConfirmed: false }, services.now(),settleWrite('unknown',{failureCode,...(observationFailed?{unattributed:true}:{})}));
          step("unknown", failureCode);
          result.uncertain += 1;
        }
        continue;
      }
      const started=observedStart as {harnessId:string;nativeConversationId:string;nativeTurnId:string}|null;
      if(observationFailed||(started&&receipt.nativeTurnId!==null&&receipt.nativeTurnId!==started.nativeTurnId)){
        markUncertainDelivery(store,projectId,message,{...(started??{}),failureCode:'NATIVE_START_OBSERVATION_CONFLICT',exitConfirmed:receipt.exitConfirmed},services.now(),settleWrite('unknown',{unattributed:true,reason:'NATIVE_START_OBSERVATION_CONFLICT'}));
        step('unknown','NATIVE_START_OBSERVATION_CONFLICT');result.uncertain++;continue;
      }
      if(started&&receipt.nativeTurnId===null)receipt={...receipt,nativeTurnId:started.nativeTurnId,status:'unknown',failureCode:'FINAL_TURN_RECEIPT_UNPROVEN'};
      services.assertOwner?.();
      const bindingCurrent = store.db.prepare('SELECT 1 FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.id=? AND b.epoch=? AND b.ended_at IS NULL AND s.harness_id=? AND s.native_conversation_id=?').get(row.binding_id,row.binding_epoch,target.harnessId,target.nativeConversationId);
      if (!bindingCurrent) {
        markUncertainDelivery(store,projectId,message,{failureCode:'DELIVERY_BINDING_CHANGED',exitConfirmed:receipt.exitConfirmed},services.now(),settleWrite('unknown',{reason:'DELIVERY_BINDING_CHANGED'}));
        result.uncertain++; continue;
      }
      try{store.transaction(()=>{if(writeProof)assertNativeWriteWithin(store,writeProof);});}
      catch{markUncertainDelivery(store,projectId,message,{failureCode:'DELIVERY_SOURCE_OR_SCOPE_CHANGED',exitConfirmed:receipt.exitConfirmed},services.now(),settleWrite('unknown',{reason:'DELIVERY_SOURCE_OR_SCOPE_CHANGED',receipt}));result.uncertain++;continue;}
      // 回执目标核验：仅精确同目标和原生turn才确认。
      const targetMismatch = receipt.harnessId !== target.harnessId || receipt.nativeConversationId !== target.nativeConversationId;
      const syntheticTurnId = typeof receipt.nativeTurnId === "string" && receipt.nativeTurnId.startsWith("cli-");
      if (targetMismatch) {
        markUncertainDelivery(store, projectId, message, { harnessId: receipt.harnessId, nativeConversationId: receipt.nativeConversationId, nativeTurnId: receipt.nativeTurnId, failureCode: "RECEIPT_TARGET_MISMATCH", exitConfirmed: false }, services.now(),settleWrite('unknown',{receipt,unattributed:true}));
        step("unknown", "RECEIPT_TARGET_MISMATCH");
        result.uncertain += 1;
        continue;
      }
      if (receipt.status === "completed" && !receipt.exitConfirmed) {
        markUncertainDelivery(store, projectId, message, { harnessId: receipt.harnessId, nativeConversationId: receipt.nativeConversationId, nativeTurnId: receipt.nativeTurnId, failureCode: "RECEIPT_EXIT_UNCONFIRMED", exitConfirmed: false }, services.now(),settleWrite('unknown',{receipt}));
        step("unknown", "RECEIPT_EXIT_UNCONFIRMED");
        result.uncertain += 1;
        continue;
      }
      if (receipt.status === "completed" && (!receipt.nativeTurnId || syntheticTurnId)) {
        markUncertainDelivery(store, projectId, message, { harnessId: receipt.harnessId, nativeConversationId: receipt.nativeConversationId, nativeTurnId: receipt.nativeTurnId, failureCode: "RECEIPT_TURN_ID_NOT_NATIVE", exitConfirmed: receipt.exitConfirmed }, services.now(),settleWrite('unknown',{receipt}));
        step("unknown", "RECEIPT_TURN_ID_NOT_NATIVE");
        result.uncertain += 1;
        continue;
      }
      if (receipt.status === "completed" && receipt.nativeTurnId) {
        markNativeSessionVerified(store, target);
        markDelivered(store, projectId, message, { harnessId: receipt.harnessId, nativeConversationId: receipt.nativeConversationId, nativeTurnId: receipt.nativeTurnId, status: receipt.status, responseText: receipt.responseText, responseLength: receipt.responseText.length, exitConfirmed: receipt.exitConfirmed, deliveredAt: services.now() }, services.now(),settleWrite('terminal',{nativeConversationId:receipt.nativeConversationId,nativeExecutionId:receipt.nativeTurnId,terminalConfirmed:true,receipt}));
        step("observed", `turn=${receipt.nativeTurnId} reply=${JSON.stringify(receipt.responseText.slice(0, REPLY_EXCERPT_MAX))}${receipt.responseText.length > REPLY_EXCERPT_MAX ? "…(截断，全文见messages.delivery_json)" : ""}`);
        result.delivered += 1;
      } else if (receipt.status === "unknown") {
        markUncertainDelivery(store, projectId, message, { harnessId: receipt.harnessId, nativeConversationId: receipt.nativeConversationId, nativeTurnId: receipt.nativeTurnId, failureCode: receipt.failureCode ?? null, ...(receipt.diagnostics?{diagnostics:safeExecutionDiagnostic(receipt.diagnostics)}:{}), exitConfirmed: receipt.exitConfirmed }, services.now(),settleWrite('unknown',{receipt}));
        step("unknown", receipt.failureCode ?? "no-reliable-receipt");
        result.uncertain += 1;
      } else {
        markDeliveryFailed(store, projectId, message, { harnessId: receipt.harnessId, nativeConversationId: receipt.nativeConversationId, nativeTurnId: receipt.nativeTurnId, failureCode: receipt.failureCode ?? "turn-failed", ...(receipt.diagnostics?{diagnostics:receipt.diagnostics}:{}), exitConfirmed: receipt.exitConfirmed }, services.now(),settleWrite(receipt.exitConfirmed&&!!receipt.nativeTurnId?'terminal':'unknown',{nativeConversationId:receipt.nativeConversationId,nativeExecutionId:receipt.nativeTurnId,terminalConfirmed:receipt.exitConfirmed,receipt}));
        step("failed", receipt.failureCode ?? "turn-failed");
        result.failed += 1;
      }
    }
    return result;
  } finally {
    pumpingStores.delete(store);
  }
}

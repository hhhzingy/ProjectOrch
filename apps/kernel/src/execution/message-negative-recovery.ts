import {createHash,randomUUID} from 'node:crypto';
import type {Store} from '@projectorch/persistence';
import {canonicalJson} from '@projectorch/persistence/outbox';
import {reconcileInterruptedMessageWithin} from '@projectorch/domain/workspaces';
import {parseSessionRef} from '@projectorch/adapter-contract';
import {inspectCodexExecution} from '../native/execution-observation.js';
import {detectCodexIdentity} from './codex-supervisor.js';
import {NativeSessionLease} from '../native/session-lease.js';
import type {NativeCompatibilityRegistry} from '../native/compatibility.js';

/** 仅受信开发/内核入口。不向HTTP/MCP开放terminal proof，所有目标均从原账本取。 */
export async function recoverInterruptedCodexMessage(store:Store,projectId:string,messageId:string,services:{executable:string;env:Readonly<Record<string,string>>;leaseDirectory:string;registry:NativeCompatibilityRegistry;assertOwner:()=>void;now:()=>number}){
 const snapshot=()=>{
  const message=store.db.prepare('SELECT * FROM messages WHERE id=? AND project_id=?').get(messageId,projectId),effect=store.db.prepare("SELECT * FROM native_write_effects WHERE project_id=? AND source_kind='message' AND source_id=? ORDER BY fence DESC LIMIT 1").get(projectId,messageId);
  if(!message||!effect)throw Error('MESSAGE_ORIGINAL_EFFECT_REQUIRED');
  const observations=store.db.prepare('SELECT * FROM native_write_effect_observations WHERE effect_id=? ORDER BY sequence').all(String(effect.id));
  return {message,effect,observations};
 };
 services.assertOwner();const before=snapshot(),evidence=before.effect.evidence_json?JSON.parse(String(before.effect.evidence_json)):{};
 if(before.message.state==='failed'&&before.effect.state==='settled'&&evidence.basis==='same-original-authoritative-negative-terminal')return {messageId,state:'failed',nativeStatus:evidence.status,replay:true,leaseStatus:'unchanged'};
 if(before.message.state!=='uncertain'||before.effect.state!=='unknown'||before.effect.purpose!=='message')throw Error('MESSAGE_ORIGINAL_EFFECT_REQUIRED');
 const session=parseSessionRef(JSON.parse(String(before.effect.session_json))),receipt=evidence.receipt;
 if(session.harnessId!=='codex'||!session.nativeWorkspaceId||!receipt||typeof receipt.nativeTurnId!=='string'||!receipt.nativeTurnId||receipt.harnessId!==session.harnessId||receipt.nativeConversationId!==session.nativeConversationId)throw Error('MESSAGE_ORIGINAL_TERMINAL_REQUIRED');
 for(const observation of before.observations){const facts=observation.evidence_json?JSON.parse(String(observation.evidence_json)):{};if(facts.unattributed===true||facts.localWriteStarted===true)throw Error('MESSAGE_ORIGINAL_TERMINAL_REQUIRED');}
 const identity={harnessId:'codex' as const,...detectCodexIdentity(services.executable),bundleSha256:null,adapterProtocol:'codex-app-server-jsonl-v2',route:'official_rpc' as const};
 if(!services.registry.decide(identity,'historyRead').enabled)throw Error('NATIVE_CAPABILITY_UNVERIFIED');
 const fingerprint=createHash('sha256').update(canonicalJson(before)).digest('hex');
 const observed=await inspectCodexExecution({executable:services.executable,env:services.env,cwd:session.nativeWorkspaceId},session,receipt.nativeTurnId);
 services.assertOwner();
 if(observed.terminalConfirmed!==true||!['failed','interrupted'].includes(observed.status)||observed.executionId!==receipt.nativeTurnId||canonicalJson(observed.session)!==canonicalJson(session))throw Error('MESSAGE_NEGATIVE_TERMINAL_NOT_PROVEN');
 const result=store.transaction(db=>{
  services.assertOwner();if(createHash('sha256').update(canonicalJson(snapshot())).digest('hex')!==fingerprint)throw Error('MESSAGE_RECOVERY_SOURCE_CHANGED');
  const now=services.now(),value=reconcileInterruptedMessageWithin(store,{projectId,messageId,sessionRef:session as unknown as Record<string,unknown>,nativeTurnId:receipt.nativeTurnId,status:observed.status as 'failed'|'interrupted',terminalConfirmed:true},now);
  db.prepare("INSERT INTO events(id,project_id,type,entity_id,entity_revision,causation_id,body_json,occurred_at) VALUES(?,?,'message.changed',?,1,?,?,?)").run(randomUUID(),projectId,messageId,String(before.message.command_id),canonicalJson({messageId,state:'failed',nativeStatus:observed.status,nativeTurnId:observed.executionId,basis:'same-original-authoritative-negative-terminal',effectId:before.effect.id,originalOwnerPreserved:true,partialBusinessEffectsNotRolledBack:true}),now);
  return value;
 });
 // 数据库已明确结束的原模型轮不会自动重发；残留活owner仍由既有租约保护。
 let leaseStatus='released';try{NativeSessionLease.recoverAfterTerminal(services.leaseDirectory,session,observed);}catch{leaseStatus='waiting-owner-or-lease-verification';}
 return {...result,nativeStatus:observed.status,replay:false,leaseStatus};
}

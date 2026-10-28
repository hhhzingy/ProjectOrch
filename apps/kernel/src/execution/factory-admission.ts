import type {Store} from '@projectorch/persistence';
import type {ControlPrincipal} from '../auth/control-entry.js';
import {readProjectPolicy} from '../auth/project-policy.js';
import {NativeRpcError} from '../native/stdio-peer.js';
import {unresolvedFactoryCapacity} from './native-capacity.js';

/** 工厂和章程也是模型输入：沿用原始授权，不为后台操作重新颁发权限。 */
export function factoryAdmissionGuard(store:Store,principal:ControlPrincipal|null,projectId:string,roleId:string,permission:'project.bootstrap'|'message.send',operationId:string,authority?:()=>void,phase:'input'|'settlement'='input'):()=>void {
 const initial=store.db.prepare('SELECT policy_revision,hold_revision FROM projects WHERE id=?').get(projectId);
 const role=store.db.prepare('SELECT revision,model_preference_revision FROM roles WHERE id=? AND project_id=?').get(roleId,projectId);
 return ()=>{
  if(!store.db.isTransaction)store.transaction(()=>{}); // 生产Store的事务guard重验同一内核owner。
  const deny=(reason:string):never=>{throw new NativeRpcError(reason,'not_sent');};
  const now=Date.now();
  if(authority){try{authority();}catch(error){if(error instanceof NativeRpcError&&error.delivery==='not_sent')throw error;deny('FACTORY_SOURCE_AUTHORIZATION_REJECTED');}}
  else{
   if(!principal||!/^control-[a-f0-9]{64}$/.test(principal.principalId))deny('CONTROL_ENTRY_AUTHORIZATION_EXPIRED');
   const source=principal as ControlPrincipal;
   const grant=store.db.prepare('SELECT project_id,permissions_json FROM control_entries WHERE token_hash=? AND created_at<=? AND expires_at>? AND revoked_at IS NULL').get(source.principalId.slice(8),now,now);
   if(!grant||(grant.project_id!=='*'&&grant.project_id!==projectId)||(source.projectId!==null&&source.projectId!==projectId)||!JSON.parse(String(grant.permissions_json)).includes(permission))deny('CONTROL_ENTRY_AUTHORIZATION_EXPIRED');
  }
  const current=store.db.prepare('SELECT policy_revision,hold_revision,user_paused FROM projects WHERE id=?').get(projectId);
  const r=store.db.prepare('SELECT revision,model_preference_revision,desired_state FROM roles WHERE id=? AND project_id=?').get(roleId,projectId);
  if(!current||current.user_paused||!r||r.desired_state!=='enabled'||current.policy_revision!==initial?.policy_revision||current.hold_revision!==initial?.hold_revision||r.revision!==role?.revision||r.model_preference_revision!==role?.model_preference_revision)deny('FACTORY_ADMISSION_CHANGED');
  if(store.db.prepare("SELECT 1 FROM goal_holds WHERE project_id=? AND state IN ('pending','awaiting_user')").get(projectId))deny('FACTORY_HELD');
  const policy=readProjectPolicy(store.db,projectId);
  if(policy.nativeMode!=='verified_only')deny('NATIVE_EXECUTION_DISABLED');
  if(policy.writeIsolation==='enforced_paths')deny('PATH_ENFORCEMENT_UNAVAILABLE');
  // 仅登记已有权威完成证明的外部效果，不发送新输入；时间/并发额度过期不应阻止事实结算。
  // 权限、凭据、暂停、目标隔离和版本检查仍在上方，下一次真正外发仍走完整input闸门。
  if(phase==='settlement')return;
  // 尚无官方费用上限传递证明，不能声称执行了硬费用限制。
  if(policy.limits.costCeiling!==null)deny('FACTORY_COST_ENFORCEMENT_UNAVAILABLE');
  const operation=store.db.prepare('SELECT created_at FROM durable_operations WHERE id=? AND project_id=?').get(operationId,projectId);
  if(!operation||now-Number(operation.created_at)>=policy.limits.wallTimeMs)deny('FACTORY_WALL_TIME_EXCEEDED');
  const dynamic=Number(store.db.prepare("SELECT COUNT(*) AS n FROM roles r WHERE r.project_id=? AND r.desired_state<>'disabled' AND NOT EXISTS(SELECT 1 FROM project_bootstrap b WHERE b.project_id=r.project_id AND b.role_id=r.id)").get(projectId)?.n);
  if(dynamic>policy.limits.maxDynamicRoles)deny('FACTORY_DYNAMIC_ROLE_LIMIT');
  const attempts=store.db.prepare("SELECT COUNT(*) AS total,COALESCE(SUM(b.role_id=?),0) AS role FROM attempts a JOIN role_bindings b ON b.id=a.binding_id WHERE a.project_id=? AND a.state IN ('dispatching','running','waiting_input','unknown')").get(roleId,projectId);
  const messages=store.db.prepare("SELECT COUNT(*) AS total,COALESCE(SUM(to_role_id=?),0) AS role FROM messages WHERE project_id=? AND state IN ('sending','uncertain')").get(roleId,projectId);
  let previousRoleCalls=0;
  for(const op of store.db.prepare('SELECT id,payload_json,steps_json FROM durable_operations WHERE project_id=?').all(projectId)){
   const payload=JSON.parse(String(op.payload_json)),steps=JSON.parse(String(op.steps_json)) as {step:string}[];
   for(let i=0;i<steps.length;i++){
    const name=steps[i]!.step;
    const match=/^role:(.+):factory-call$/.exec(name);
    if(match||name==='factory-call'){
     const target=match?.[1]??payload.toRoleId;
     if(typeof target!=='string')continue;
     if(target===roleId&&op.id!==operationId)previousRoleCalls++;
    }
   }
  }
  if(previousRoleCalls>=policy.limits.maxAttempts)deny('FACTORY_ATTEMPTS_EXCEEDED');
  const capacity=unresolvedFactoryCapacity(store.db,projectId,roleId,{operationId,roleId});
  if(Number(attempts?.total)+Number(messages?.total)+capacity.total>=policy.limits.totalConcurrency||Number(attempts?.role)+Number(messages?.role)+capacity.role>=policy.limits.roleConcurrency)deny('FACTORY_CONCURRENCY_EXCEEDED');
 };
}

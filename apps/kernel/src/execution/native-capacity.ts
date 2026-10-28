import type {Store} from '@projectorch/persistence';
/** 工厂调用也是原生占位；未知创建不能因任务/消息来自另一通路而被忽略。 */
export function unresolvedFactoryCapacity(db:Store['db'],projectId:string,roleId:string,exclude?:{operationId:string;roleId:string}):{total:number;role:number}{
 let total=0,role=0;
 for(const operation of db.prepare('SELECT id,payload_json,steps_json FROM durable_operations WHERE project_id=?').all(projectId)){
  const payload=JSON.parse(String(operation.payload_json)),steps=JSON.parse(String(operation.steps_json)) as {step:string;state:string;detail?:string|null}[];
  const calls=new Map<string,number>();
  for(let i=0;i<steps.length;i++){
   const name=steps[i]!.step,match=/^role:(.+):factory-call$/.exec(name);
   if(match||name==='factory-call'){const target=match?.[1]??payload.toRoleId;if(typeof target==='string')calls.set(target,i);}
  }
  for(const [target,index] of calls){
   if(exclude&&exclude.operationId===operation.id&&exclude.roleId===target)continue;
   const prefix=payload.toRoleId===target?'':`role:${target}:`;
   const segment=steps.slice(index+1),created=segment.some(s=>s.state==='observed'&&['create-thread','create-session','session-identity'].some(name=>s.step===prefix+name));
   if(segment.some(s=>{
    if(s.step===`${prefix}session-not-sent`&&s.state==='failed')return !created;
    if(s.step!==`${prefix}binding-registration`||s.state!=='observed'||!s.detail)return false;
    try{return JSON.parse(s.detail).charterDelivered===true;}catch{return false;}
   }))continue;
   total++;if(target===roleId)role++;
  }
 }return {total,role};
}

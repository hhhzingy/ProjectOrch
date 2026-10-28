import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import type {Store} from '@projectorch/persistence';
import {canonicalJson} from '@projectorch/persistence/outbox';
import {isWellFormedPathTemplate} from '@projectorch/domain/policy';
import {jsonAssertionSchemaId} from './validators.js';

const outboxModule=new URL(import.meta.resolve('@projectorch/persistence/outbox'));
const entryFiles=[new URL('./validators.js',import.meta.url),new URL(import.meta.resolve('@projectorch/domain/policy')),outboxModule,new URL('./json.js',outboxModule)];
const entryManifest=()=>entryFiles.map((url,index)=>({component:index,sha256:createHash('sha256').update(readFileSync(url)).digest('hex')}));
const loadedEntryManifest=entryManifest(),loadedEntryHash=createHash('sha256').update(canonicalJson(loadedEntryManifest)).digest('hex');
export function trustedCheckEntries(){if(canonicalJson(entryManifest())!==canonicalJson(loadedEntryManifest))throw Error('CHECK_RUNTIME_ENTRY_CHANGED_RESTART_REQUIRED');return [{runner:'registered_validator' as const,entryId:'projectorch.json-assertions.v1',entrySha256:loadedEntryHash,entryManifest:loadedEntryManifest.map(item=>({...item})),parameterSchemaId:jsonAssertionSchemaId,permissions:['target.read'],isolation:'trusted-in-process-readonly-bytes',environment:'no-child-process-or-inherited-environment'}];}
export function validateTrustedCheckDefinition(definition:unknown){
 // CheckDefinition由命令Schema先作结构验证；这里核对内核实际登记入口及能力。
 const value=definition as {runner:string;entryId:string;entrySha256:string;parameterSchemaId:string;permissions:string[];scopePaths:string[];timeoutMs:number};
 const entry=trustedCheckEntries().find(e=>e.runner===value.runner&&e.entryId===value.entryId);
 if(!entry)throw Error('CHECK_RUNNER_ENTRY_UNSUPPORTED');
 if(value.entrySha256!==entry.entrySha256)throw Error('CHECK_ENTRY_HASH_CHANGED');
 if(value.parameterSchemaId!==entry.parameterSchemaId||canonicalJson(value.permissions)!==canonicalJson(entry.permissions))throw Error('CHECK_CAPABILITY_UNAVAILABLE');
 if(!value.scopePaths.length||value.scopePaths.some(p=>!isWellFormedPathTemplate(p))||value.timeoutMs>10000)throw Error('CHECK_SCOPE_OR_TIMEOUT_UNSUPPORTED');
 return entry;
}

/** 仅已认证用户命令管线调用；旧域函数写入不被猜填为生产可信注册。 */
export function registerTrustedCheckWithin(store:Store,projectId:string,definition:unknown,commandId:string,userId:string,now:number){
 const db=store.db;if(!db.isTransaction)throw Error('CHECK_REGISTRATION_TRANSACTION_REQUIRED');validateTrustedCheckDefinition(definition);
 const d=definition as {id:string;version:string;enabled:boolean};
 const source=db.prepare("SELECT source_principal_id,payload_json FROM commands WHERE id=? AND project_id=? AND type='check.register' AND state='stored'").get(commandId,projectId);
 if(!source||source.source_principal_id!==userId||canonicalJson(JSON.parse(String(source.payload_json)).definition)!==canonicalJson(definition))throw Error('CHECK_REGISTRATION_SOURCE_MISMATCH');
 const existing=db.prepare('SELECT definition_json FROM check_definitions WHERE project_id=? AND id=? AND version=?').get(projectId,d.id,d.version);
 if(existing){
  const previous=JSON.parse(String(existing.definition_json)),current=JSON.parse(canonicalJson(definition));delete previous.enabled;delete current.enabled;if(canonicalJson(previous)!==canonicalJson(current))throw Error('CHECK_DEFINITION_NEW_VERSION_REQUIRED');
  db.prepare('UPDATE check_definitions SET enabled=?,definition_json=? WHERE project_id=? AND id=? AND version=?').run(d.enabled?1:0,canonicalJson(definition),projectId,d.id,d.version);
 }else db.prepare('INSERT INTO check_definitions(project_id,id,version,definition_json,enabled) VALUES(?,?,?,?,?)').run(projectId,d.id,d.version,canonicalJson(definition),d.enabled?1:0);
 const authorizationId='check-auth-'+randomUUID();db.prepare('INSERT INTO check_definition_authorizations(id,project_id,check_id,check_version,command_id,authorized_user_id,definition_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(authorizationId,projectId,d.id,d.version,commandId,userId,canonicalJson(definition),now);
 return {checkId:d.id,checkVersion:d.version,authorizationId,enabled:d.enabled};
}

/** 运行前要求真实用户注册来源和当前入口字节；历史裸check_definitions不能取得运行权。 */
export function trustedCheckDefinitionForRun(store:Store,projectId:string,id:string,version:string){
 const row=store.db.prepare('SELECT definition_json,enabled FROM check_definitions WHERE project_id=? AND id=? AND version=?').get(projectId,id,version);if(!row||row.enabled!==1)throw Error('CHECK_DEFINITION_NOT_ENABLED');
 const grant=store.db.prepare("SELECT a.id,a.definition_json FROM check_definition_authorizations a JOIN commands c ON c.id=a.command_id AND c.project_id=a.project_id WHERE a.project_id=? AND a.check_id=? AND a.check_version=? AND c.type='check.register' AND c.state='completed' AND c.source_principal_id=a.authorized_user_id ORDER BY a.rowid DESC LIMIT 1").get(projectId,id,version);
 if(!grant||grant.definition_json!==row.definition_json)throw Error('CHECK_TRUSTED_REGISTRATION_REQUIRED');const definition=JSON.parse(String(row.definition_json));const entry=validateTrustedCheckDefinition(definition);return {definition,entry,authorizationId:String(grant.id)};
}

import type { Store } from "@projectorch/persistence";
import type { CommandServices } from "./index.js";
import { lifecycleCommandServices } from "./lifecycle-services.js";
import { authorizeUserAction } from "../auth/policy-check.js";
import { taskAcceptanceWithin } from "./task-acceptance.js";
import {answerQuestionWithin} from '../tools/question-workflow.js';
import {randomUUID} from 'node:crypto';
import {registerTrustedCheckWithin} from '../checks/registry.js';

/** 标准应用用户命令；主体仅由已配对浏览器认证层传入，不接受正文身份。 */
export function userCommandServices(store: Store, now: () => number = Date.now): CommandServices {
  const lifecycle = lifecycleCommandServices(now);
  const handlers = new Map(lifecycle.handlers);
  handlers.set('check.register',(db,commandId,command)=>{
    if(command.type!=='check.register'||db!==store.db)throw Error('INVALID_CHECK_COMMAND');
    const source=db.prepare('SELECT source_principal_id FROM commands WHERE id=? AND project_id=?').get(commandId,command.projectId);if(!source)throw Error('COMMAND_NOT_FOUND');
    const value=registerTrustedCheckWithin(store,command.projectId,command.payload.definition,commandId,String(source.source_principal_id),now());
    db.prepare("INSERT INTO events(id,project_id,type,entity_id,entity_revision,causation_id,body_json,occurred_at) VALUES(?,?,'check.registered',?,1,?,?,?)").run(randomUUID(),command.projectId,value.checkId,commandId,JSON.stringify(value),now());
    return {requestId:command.requestId,projectId:command.projectId,commandId,status:'completed',receiptUrl:`/api/v1/commands/${commandId}/receipt`,entityIds:[{localRef:value.checkId,entityType:'check',id:value.checkId,revision:1,version:value.checkVersion}],error:null,lastEventSequence:Number(db.prepare('SELECT MAX(sequence) AS n FROM events WHERE project_id=?').get(command.projectId)?.n)};
  });
  handlers.set('question.answer',(db,commandId,command)=>{
    if(command.type!=='question.answer'||db!==store.db)throw Error('INVALID_QUESTION_COMMAND');
    const question=answerQuestionWithin(store,{kind:'authenticated_user'},command.projectId,command.payload,commandId,now(),false);
    db.prepare("INSERT INTO events(id,project_id,type,entity_id,entity_revision,causation_id,body_json,occurred_at) VALUES(?,?,'question.answered',?,?,?,?,?)").run(randomUUID(),command.projectId,question.id,question.revision,commandId,JSON.stringify({question}),now());
    return {requestId:command.requestId,projectId:command.projectId,commandId,status:'completed',receiptUrl:`/api/v1/commands/${commandId}/receipt`,entityIds:[{localRef:question.id,entityType:'question',id:question.id,revision:question.revision,version:null}],error:null,lastEventSequence:Number(db.prepare('SELECT MAX(sequence) AS n FROM events WHERE project_id=?').get(command.projectId)?.n)};
  });
  handlers.set("task.accept", (db, commandId, command) => {
    if (command.type !== "task.accept" || db !== store.db) throw new Error("INVALID_ACCEPTANCE_COMMAND");
    const source = db.prepare("SELECT source_principal_id FROM commands WHERE id=? AND project_id=?").get(commandId, command.projectId);
    if (!source) throw new Error("COMMAND_NOT_FOUND");
    return taskAcceptanceWithin(store, { id: String(source.source_principal_id), kind: "authenticated_user" }, command.projectId, command.payload, commandId, command.requestId, now(), () => {}).receipt;
  });
  return { authorize: (db, principalId, command) => command.type==='check.register'?!!principalId&&authorizeUserAction({action:'check.register',targetProjectId:command.projectId,kind:'control'}).allowed:command.type==='question.answer'?!!principalId&&authorizeUserAction({action:'question.answer_designated',targetProjectId:command.projectId,kind:'write'}).allowed:command.type === "task.accept"
    ? !!principalId && authorizeUserAction({ action: "task.accept_assigned", targetProjectId: command.projectId, kind: "write" }).allowed
    : lifecycle.authorize(db, principalId, command), handlers };
}

import type {Store} from '@projectorch/persistence';
import {workspaceWriterConflict} from '@projectorch/domain/workspaces';

/** 集成与派发使用同一物理写范围谓词；只读检查不释放任何占位。 */
export function assertWorkspaceWritersQuiescent(store:Store,projectId:string,workspaceId:string){
 if(!store.db.isTransaction)throw Error('WORKSPACE_WRITER_TRANSACTION_REQUIRED');
 const conflict=workspaceWriterConflict(store,projectId,workspaceId);
 if(conflict)throw Error(conflict==='overlap'?'INTEGRATION_TARGET_UNRESOLVED_WRITER_OVERLAP':'INTEGRATION_TARGET_UNRESOLVED_WRITER_IDENTITY');
}

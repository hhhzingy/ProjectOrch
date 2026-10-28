import type {Store} from '@projectorch/persistence';
import type {SessionRef} from '@projectorch/adapter-contract';
import type {NativeModelSelection} from '../native/model-selection.js';
import {NativeRpcError} from '../native/stdio-peer.js';

export function bindingForSession(store:Store,session:SessionRef):string{
 const row=store.db.prepare('SELECT b.id FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.ended_at IS NULL AND s.harness_id=? AND s.host_id=? AND s.profile_id=? AND s.native_conversation_id=? AND COALESCE(s.native_workspace_id,?)=?').get(session.harnessId,session.hostId,session.profileId,session.nativeConversationId,'',session.nativeWorkspaceId??'');
 if(!row)throw new Error('BINDING_NOT_FOUND');return String(row.id);
}
/** requested未解析必须阻塞，不把默认模型冒充严格要求。 */
export function bindingModelSelection(store:Store,bindingId:string):NativeModelSelection|null{
 const row=store.db.prepare('SELECT r.model_requested_json,r.model_resolved_json FROM role_bindings b JOIN roles r ON r.id=b.role_id AND r.project_id=b.project_id WHERE b.id=? AND b.ended_at IS NULL').get(bindingId);
 if(!row)throw new NativeRpcError('BINDING_NOT_FOUND','not_sent');
 if(!row.model_requested_json)return null;
 if(!row.model_resolved_json)throw new NativeRpcError('MODEL_SELECTION_UNRESOLVED','not_sent');
 const value=JSON.parse(String(row.model_resolved_json)) as NativeModelSelection;
 if((value.modelId!==null&&(typeof value.modelId!=='string'||!value.modelId||value.modelId.length>128))||(value.reasoningLevel!==null&&(typeof value.reasoningLevel!=='string'||!value.reasoningLevel||value.reasoningLevel.length>32))||(!value.modelId&&!value.reasoningLevel))throw new NativeRpcError('MODEL_SELECTION_UNRESOLVED','not_sent');
 return {modelId:value.modelId,reasoningLevel:value.reasoningLevel,...(value.providerId?{providerId:value.providerId}:{})};
}

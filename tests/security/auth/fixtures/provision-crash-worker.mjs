// 仅用于受控故障测试；无官方软件/模型输入，父进程在真实持久边界强制结束本子进程。
import {openStore} from '../../../../packages/persistence/dist/index.js';
import {issueAgentCredential,authenticateAgentCredential} from '../../../../apps/kernel/dist/auth/agent-credential.js';
import {pumpRoleProvisioning} from '../../../../apps/kernel/dist/tools/role-provisioning.js';
const [filename,workspace,boundary]=process.argv.slice(2),store=openStore(filename);
const session={harnessId:'zcode',hostId:'host',profileId:'synthetic-only',nativeConversationId:'synthetic-native'};
const token=issueAgentCredential(store,'binding',1,{isolation:'verified_session',session},Date.now(),600000).credential;
const factory={async ensureBoundSession(input){
 input.assertCanSend();if(boundary==='after-id')input.onStep({step:'create-thread',state:'observed',detail:'original-created-id',at:Date.now()});
 process.send({boundary});await new Promise(()=>{});
}};
pumpRoleProvisioning(store,factory,{now:Date.now,isOwner:()=>true,workspaceForRole:()=>workspace,onBoundSession:()=>{},principalForBinding:()=>authenticateAgentCredential(store,token,Date.now())});

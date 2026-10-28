// 专用合成角色测试进程；凭据仅经父子IPC传入，不记录或读取用户认证。
import { openStore } from '../../../packages/persistence/dist/index.js';
import { authenticateAgentCredential } from '../../../apps/kernel/dist/auth/agent-credential.js';
import { createToolDispatcher } from '../../../apps/kernel/dist/tools/gateway-tools.js';

const store = openStore(process.argv[2]);
process.once('message', message => {
  try {
    const principal = authenticateAgentCredential(store, message.credential, 300);
    const dispatcher = createToolDispatcher(store, { now: () => 300, callerNativeConversationId: 'native-1' });
    const result = dispatcher(principal, 'message.send', message.input);
    store.close();
    process.send(result, () => process.disconnect());
  } catch {
    store.close();
    process.send({ ok: false }, () => { process.exitCode = 1; process.disconnect(); });
  }
});
process.send({ type: 'ready' });

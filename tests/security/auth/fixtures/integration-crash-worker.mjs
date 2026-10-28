// 仅测试自有合成SQLite；stdin包含临时测试凭据，不写日志/文件、不读用户认证。
import fs from 'node:fs';import{openStore}from'../../../../packages/persistence/dist/index.js';import{authenticateAgentCredential}from'../../../../apps/kernel/dist/auth/agent-credential.js';import{createToolDispatcher}from'../../../../apps/kernel/dist/tools/gateway-tools.js';
const input=JSON.parse(fs.readFileSync(0,'utf8')),store=openStore(input.filename),principal=authenticateAgentCredential(store,input.credential,300);
const crash=()=>{fs.writeSync(1,'INTEGRATION_CRASH_POINT:'+input.boundary+'\n');process.kill(process.pid,'SIGKILL');};
if(input.boundary!=='committed'){
 // 仅包装本子进程的目标SQL调用进行故障注入；不修改产品SQL安全pragma或用户数据。
 const prepare=store.db.prepare.bind(store.db);store.db.prepare=(sql)=>{const statement=prepare(sql);if(sql.startsWith('INSERT INTO integration_check_runs(')){const run=statement.run.bind(statement);statement.run=(...args)=>{if(input.boundary==='before-run')crash();const value=run(...args);crash();return value;};}return statement;};
}
const result=createToolDispatcher(store,{now:()=>300,callerNativeConversationId:principal.session.nativeConversationId})(principal,'integration.evaluate',input.evaluation);if(!result.ok){fs.writeSync(2,'INTEGRATION_SETUP_REJECTED:'+String(result.payload.error)+'\n');process.exit(2);}if(input.boundary==='committed')crash();process.exit(3);

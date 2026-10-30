// 只运行导出白名单中的合成应用测试，不启动官方Harness/模型。
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const roots=['compatibility','unit','contracts','adapters','security','storage','plan-impact','recovery','upgrade'];
const files=[];
function walk(p){for(const entry of fs.readdirSync(p,{withFileTypes:true})){const f=path.join(p,entry.name);if(entry.isSymbolicLink())throw Error('TEST_LINK_REJECTED');if(entry.isDirectory())walk(f);else if(entry.name.endsWith('.test.mjs'))files.push(f);}}
for(const name of roots)if(fs.existsSync('tests/'+name))walk('tests/'+name);
if(!files.length)throw Error('OFFLINE_TESTS_MISSING');
const result=spawnSync(process.execPath,['--test','--test-concurrency=2','--test-timeout=60000',...files.sort()],{stdio:'inherit',windowsHide:true,env:{...process.env,PROJECTORCH_NATIVE_TESTS:'0'}});
process.exitCode=result.status??1;

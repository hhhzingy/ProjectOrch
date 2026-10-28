import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {zipSync,strToU8} from 'fflate';
import {verifyWindowsCandidate} from '../../scripts/build-windows-candidate.mjs';
const fixture=()=>{const body=strToU8('synthetic'),manifest={kind:'ProjectOrch Windows private candidate',files:[{path:'README.txt',size:body.length,sha256:createHash('sha256').update(body).digest('hex')}]};return {body,manifest};};
const zip=(f,extra={})=>zipSync({'ProjectOrch/MANIFEST.json':strToU8(JSON.stringify(f.manifest)),'ProjectOrch/README.txt':f.body,...extra});
test('Windows候选清单拒绝篡改、清单外私有文件和Windows路径别名',()=>{
 const f=fixture();assert.deepEqual(verifyWindowsCandidate(zip(f)),[]);
 assert.ok(verifyWindowsCandidate(zip(f,{'ProjectOrch/reports/native/private.png':strToU8('private')})).some(e=>e.startsWith('UNLISTED_FILE')));
 assert.ok(verifyWindowsCandidate(zip({...f,body:strToU8('tampered')})).some(e=>e.startsWith('FILE_HASH_MISMATCH')));
 for(const p of ['../secret','work/../secret','C:/secret','folder\\secret','CON.txt','file:stream','name.','bad?','bad|name','bad*','bad\u0000']){
  const bad=fixture();bad.manifest.files[0].path=p;assert.ok(verifyWindowsCandidate(zip(bad)).includes('MANIFEST_ENTRY_INVALID'),p);
 }
 const duplicate=fixture();duplicate.manifest.files.push({...duplicate.manifest.files[0],path:'readme.TXT'});assert.ok(verifyWindowsCandidate(zip(duplicate)).includes('MANIFEST_ENTRY_INVALID'));
});

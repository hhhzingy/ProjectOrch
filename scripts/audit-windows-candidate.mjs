/** 从实际ZIP生成运行依赖/内容核对；不读取开发机认证、私有报告或用户会话。 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {unzipSync,strFromU8} from 'fflate';
import {verifyWindowsCandidate} from './build-windows-candidate.mjs';

const root=fs.realpathSync(fileURLToPath(new URL('..',import.meta.url)));
if(process.argv.length!==3)throw Error('EXPECTED_CANDIDATE_ZIP');
const bytes=fs.readFileSync(path.resolve(process.argv[2])),hash=value=>createHash('sha256').update(value).digest('hex'),sha256=hash(bytes);
assert.deepEqual(verifyWindowsCandidate(bytes),[]);const entries=unzipSync(bytes),parse=name=>JSON.parse(strFromU8(entries['ProjectOrch/'+name]));
const manifest=parse('MANIFEST.json'),inventory=parse('DEPENDENCIES.json'),sources=parse('BUILD_SOURCES.json');
assert.equal(hash(Buffer.from(JSON.stringify(sources))),manifest.sourceSnapshotSha256);assert.equal(hash(entries['ProjectOrch/runtime/node.exe']),inventory.node.sha256);
assert.equal(manifest.ownLicense,'UNDECIDED');assert.equal(manifest.publicReleaseAuthorized,false);
const names=Object.keys(entries).map(name=>name.replace(/^ProjectOrch\//,''));
assert.equal(names.some(name=>/(^|\/)(reports|work|planning|\.codex|\.zcode|auth\.json|state\.sqlite|binding-credentials\.json|control-entry\.json)(\/|$)/i.test(name)),false);
assert.equal(names.includes('LICENSE'),false);
const dependencies=inventory.dependencies,known=new Set(dependencies.map(p=>p.name)),licenses=[];
for(const item of dependencies){
 const prefix=item.name==='@projectorch/kernel'?'apps/kernel/':'node_modules/'+item.name+'/';
 const metadata=entries['ProjectOrch/'+prefix+'package.json'];assert.ok(metadata);assert.equal(hash(metadata),item.packageSha256);const actual=JSON.parse(strFromU8(metadata));assert.equal(actual.name,item.name);assert.equal(actual.version,item.version);
 for(const dependency of item.dependencies){const dependencyName=dependency.slice(0,dependency.lastIndexOf('@'));assert.ok(known.has(dependencyName),'actual runtime dependency closure must be complete');}
 if(!item.name.startsWith('@projectorch/')){
  const licensePaths=names.filter(name=>name.startsWith(prefix)&&/^(license|copying)(\.|$)/i.test(path.posix.basename(name)));assert.ok(licensePaths.length,'third-party license text missing');
  for(const licensePath of licensePaths){const body=entries['ProjectOrch/'+licensePath];assert.ok(body.length>20);licenses.push({package:item.name,version:item.version,declaredLicense:item.license,path:licensePath,sha256:hash(body)});}
 }
}
assert.ok(entries['ProjectOrch/runtime/NODE_LICENSE.txt'].length>1000);
const audit={schemaVersion:1,scope:'actual private Windows ZIP runtime closure and explicit content audit; not independent secret scanning or publisher attestation',recordedAt:new Date().toISOString(),sha256,files:manifest.files.length,sourceSnapshotSha256:manifest.sourceSnapshotSha256,node:inventory.node,dependencies:dependencies.length,thirdPartyPackages:dependencies.filter(p=>!p.name.startsWith('@projectorch/')).length,licenses,checks:{fileHashes:true,dependencyMetadataHashes:true,dependencyClosure:true,licenseTextsPresent:true,privateDirectoriesExcluded:true,rootLicenseNotChosen:true,publicReleaseNotAuthorized:true},status:'PRIVATE_CANDIDATE_CONTENT_AUDIT_PASS'};
const components=dependencies.map(item=>({type:item.name.startsWith('@projectorch/')?'application':'library','bom-ref':item.name+'@'+item.version,name:item.name,version:item.version,...(!item.name.startsWith('@projectorch/')&&['MIT','BSD-3-Clause','BSD-2-Clause','ISC','Apache-2.0'].includes(item.license)?{licenses:[{license:{id:item.license}}]}:{}),properties:[{name:'projectorch:package-json-sha256',value:item.packageSha256}]}));
components.push({type:'application','bom-ref':'node@'+inventory.node.version,name:'Node.js',version:inventory.node.version.replace(/^v/,''),hashes:[{alg:'SHA-256',content:inventory.node.sha256}],properties:[{name:'projectorch:license-text-sha256',value:hash(entries['ProjectOrch/runtime/NODE_LICENSE.txt'])}]});
const sbom={bomFormat:'CycloneDX',specVersion:'1.6',serialNumber:'urn:uuid:'+randomUUID(),version:1,metadata:{timestamp:new Date().toISOString(),component:{type:'application','bom-ref':'ProjectOrch-private-'+sha256,name:'ProjectOrch Windows private candidate',version:manifest.applicationVersion,hashes:[{alg:'SHA-256',content:sha256}]},properties:[{name:'projectorch:scope',value:'ACTUAL_PRIVATE_ZIP_INVENTORY_NOT_PUBLISHER_ATTESTATION'},{name:'projectorch:own-license',value:'UNDECIDED'},{name:'projectorch:schema-validation',value:'NOT_INDEPENDENTLY_VALIDATED'}]},components,dependencies:[{ref:'ProjectOrch-private-'+sha256,dependsOn:['@projectorch/kernel@'+dependencies.find(p=>p.name==='@projectorch/kernel').version,'node@'+inventory.node.version]},...dependencies.map(item=>({ref:item.name+'@'+item.version,dependsOn:item.dependencies})),{ref:'node@'+inventory.node.version,dependsOn:[]}]};
const out=path.join(root,'reports/release');fs.mkdirSync(out,{recursive:true});for(const [suffix,value] of [['content-audit.json',audit],['runtime.cdx.json',sbom]]){const filename=path.join(out,'windows-'+sha256.slice(0,16)+'-'+suffix);if(fs.existsSync(filename))throw Error('REPORT_EXISTS');fs.writeFileSync(filename,JSON.stringify(value,null,2)+'\n');}
console.log(JSON.stringify({status:audit.status,sha256,dependencies:audit.dependencies,thirdPartyPackages:audit.thirdPartyPackages,sbomSchemaValidated:false}));

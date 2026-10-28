import type {Store} from '@projectorch/persistence';
import {readProject} from '@projectorch/domain/projects';
import {resolveWithinProject,readFileFingerprint} from '@projectorch/domain/artifacts';
import path from 'node:path';
/** Agent文件路径始终相对项目根；不搜索绑定工作区或按文件名fallback。 */
export function assertAgentArtifactFile(store:Store,projectId:string,pathRef:string,sha256:string,byteSize:number,assertPath:(relativePath:string)=>void):void{
 const root=readProject(store,projectId).canonicalRoot;
 const boundary=resolveWithinProject(root,pathRef);
 if(!boundary.ok)throw Error('ARTIFACT_PATH_MUST_BE_PROJECT_RELATIVE');
 // junction仍可能落在项目内但超出角色scope；真实路径须先授权，之后才读字节。
 assertPath(path.relative(root,boundary.absolutePath).replaceAll('\\','/'));
 const observed=readFileFingerprint(boundary.absolutePath);
 if(!observed)throw Error('ARTIFACT_FILE_MISSING_USE_PROJECT_RELATIVE_PATH');
 if(observed.sha256!==sha256||observed.byteSize!==byteSize)throw Error('ARTIFACT_FILE_HASH_OR_SIZE_MISMATCH');
}

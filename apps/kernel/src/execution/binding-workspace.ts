import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from 'node:path';
import type { Store } from "@projectorch/persistence";
import { canonicalRoot } from "@projectorch/domain/projects";
import { registerWorkspaceWithin } from "@projectorch/domain/workspaces";
import { readProjectPolicy } from "../auth/project-policy.js";
import { canonicalJson } from "@projectorch/persistence/outbox";

/** 默认角色工作目录在项目内，保证登记的相对成果能由同一项目读取；旧绑定仍保留原目录。 */
export function bindingWorkspaceDirectory(store: Store, projectId: string, bindingId: string, create=true): string {
  const project=store.db.prepare('SELECT canonical_root FROM projects WHERE id=?').get(projectId);
  if(!project)throw new Error('PROJECT_NOT_FOUND');
  const root=realpathSync.native(String(project.canonical_root));
  const name=createHash('sha256').update(canonicalJson([projectId,bindingId])).digest('hex');
  const directory=path.join(root,'.projectorch','workspaces',name);
  for(let cursor=directory;cursor!==root;cursor=path.dirname(cursor)){
    if(!cursor.startsWith(root.endsWith(path.sep)?root:root+path.sep))throw new Error('WORKSPACE_PATH_OUT_OF_SCOPE');
    if(existsSync(cursor)){const stat=lstatSync(cursor);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('WORKSPACE_IDENTITY_CHANGED');}
  }
  if(!create)return directory;
  mkdirSync(directory,{recursive:true});
  const actual=realpathSync.native(directory);
  if(!actual.startsWith(root.endsWith(path.sep)?root:root+path.sep))throw new Error('WORKSPACE_PATH_OUT_OF_SCOPE');
  return actual;
}

/** 受信启动器将已绑定的真实目录登记为工作区ID。只消费现有策略，不授予权限或强隔离。 */
export function ensureBindingWorkspace(store: Store, projectId: string, taskId: string, bindingId: string, trustedWorkspaceRoot: string, now: number): string {
  const run = (): string => {
    const db = store.db;
    const row = db.prepare("SELECT r.permission_profile,r.permission_profile_revision,s.native_workspace_id FROM role_bindings b JOIN roles r ON r.id=b.role_id AND r.project_id=b.project_id JOIN sessions s ON s.id=b.session_id JOIN tasks t ON t.role_id=r.id AND t.project_id=r.project_id WHERE b.id=? AND b.project_id=? AND b.ended_at IS NULL AND t.id=?").get(bindingId, projectId, taskId);
    if (!row) throw new Error("WORKFLOW_BINDING_REQUIRED");
    const policy = readProjectPolicy(db, projectId);
    const profile = policy.profiles.find(p => p.id === row.permission_profile && p.revision === row.permission_profile_revision);
    if (!profile) throw new Error("POLICY_PROFILE_REVISION_CONFLICT");
    if (policy.nativeMode !== "verified_only") throw new Error("NATIVE_EXECUTION_DISABLED");
    // 只登记advisory，绝不通过数据库标签制造enforced_paths能力。
    if (policy.writeIsolation === "enforced_paths") throw new Error("PATH_ENFORCEMENT_UNAVAILABLE");
    const root = canonicalRoot(realpathSync.native(trustedWorkspaceRoot));
    if (row.native_workspace_id && root !== canonicalRoot(realpathSync.native(String(row.native_workspace_id)))) throw new Error("WORKSPACE_IDENTITY_CHANGED");
    const id = `binding-ws-${createHash("sha256").update(canonicalJson([projectId, bindingId])).digest("hex")}`;
    const existing = db.prepare("SELECT * FROM workspaces WHERE id=?").get(id);
    if (existing) {
      if (existing.project_id !== projectId || existing.canonical_path !== root || existing.managed !== 1 || existing.enforcement !== "advisory" || canonicalJson(JSON.parse(String(existing.write_paths_json))) !== canonicalJson(profile.writePaths)) throw new Error("WORKSPACE_IDENTITY_CHANGED");
      if (existing.state === "retired" || existing.state === "unknown") throw new Error("WORKSPACE_NOT_AVAILABLE");
      return id;
    }
    registerWorkspaceWithin(db, { id, projectId, canonicalPath: root, managed: true, enforcement: "advisory", writePaths: profile.writePaths }, now);
    return id;
  };
  return store.db.isTransaction ? run() : store.transaction(run);
}

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 不覆盖用户配置：仅更新带有本绑定所有权、且字节未被外部修改的自建文件。 */
export function writeBindingToolConfig(workspaceRoot: string, projectId: string, bindingId: string, url: string, credential: string): void {
  const directory = path.join(path.resolve(workspaceRoot), '.zcode');
  mkdirSync(directory, { recursive: true });
  const configFile = path.join(directory, 'config.json');
  const ownershipFile = path.join(directory, 'projectorch-binding.json');
  const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
  type Ownership = { projectId: string; bindingId: string; configSha256?: string };
  let previous: Ownership | null = null;
  if (existsSync(ownershipFile)) previous = JSON.parse(readFileSync(ownershipFile, 'utf8')) as Ownership;
  if (previous && (previous.projectId !== projectId || previous.bindingId !== bindingId)) throw new Error('ROLE_TOOL_WORKSPACE_COLLISION');
  if (existsSync(configFile) && (!previous?.configSha256 || digest(readFileSync(configFile)) !== previous.configSha256)) throw new Error('EXISTING_ROLE_CONFIG_PRESERVED');
  // 先占有目录；并发不同角色无法一起取得同一工作区。
  if (!previous) writeFileSync(ownershipFile, JSON.stringify({ projectId, bindingId }), { flag: 'wx', mode: 0o600 });
  const text = JSON.stringify({ mcp: { servers: { projectorch: { type: 'http', url, headers: { Authorization: `Bearer ${credential}` } } } } }, null, 2) + '\n';
  writeFileSync(configFile, text, { mode: 0o600 });
  writeFileSync(ownershipFile, JSON.stringify({ projectId, bindingId, configSha256: digest(text) }) + '\n', { mode: 0o600 });
}

/** 官方每进程覆盖；环境变量保存项目凭据，参数列表不包含凭据正文。 */
export function codexRoleToolOverrides(url: string, approvedToolNames?: readonly string[]): readonly string[] {
  if (approvedToolNames?.some(name => !/^projectorch_[a-z_]+$/.test(name))) throw new Error('INVALID_ROLE_TOOL_NAME');
  const approved = approvedToolNames === undefined ? undefined : [...new Set(approvedToolNames)].sort();
  return Object.freeze([
    `mcp_servers.projectorch.url=${JSON.stringify(url)}`,
    'mcp_servers.projectorch.bearer_token_env_var="PROJECTORCH_ROLE_CREDENTIAL"',
    'mcp_servers.projectorch.enabled=true',
    ...(approved === undefined ? [] : [
      `mcp_servers.projectorch.enabled_tools=${JSON.stringify(approved)}`,
      ...approved.map(name => `mcp_servers.projectorch.tools.${name}.approval_mode="approve"`),
    ]),
  ]);
}

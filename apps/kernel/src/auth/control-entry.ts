import { adoptExistingConversation } from "../auth/adopt-conversation.js";
import {hostname} from 'node:os';
import {toolArgumentSchema,parseToolArguments} from '@projectorch/contracts';
import {createProjectForUser} from '../commands/project-create.js';
import { readOperation, completeBindingStartupAck } from "../tools/orchestration-tools.js";
import { reopenBlockedTask } from "@projectorch/domain/tasks";
import { parseSessionRef,type SessionRef } from '@projectorch/adapter-contract';
/** DR01（PR2修复）：控制入口主体（Control Principal）——已有对话经MCP工具入口的授权身份。
 * 与受管角色主体（SessionToolHost，受信启动器确认的会话/绑定/执行）分开：
 * - 控制主体由一次性配对码建立（用户从本地内核控制台/启动器获得），绑定受信项目清单
 * - 未配对的MCP连接=unbound（只可发现工具名，不可执行业务动作）
 * - 授权动作：项目级控制（bootstrap/团队/消息/任务派发意图）——不冒充角色身份 */
import { createHash, randomUUID } from "node:crypto";
import type { Store } from "@projectorch/persistence";
import { authorizeAgentAction } from "../auth/policy-check.js";

export interface ControlPrincipal {
  readonly kind: "control_entry";
  readonly principalId: string;
  readonly projectId: string | null; // null=全局未绑定项目（可列项目）
  readonly permissions: readonly string[];
}

/** 一次性控制码（受信启动器生成保存；MCP配置写入此token=控制主体凭据）——自管理control_entries表 */
export function issueControlEntryToken(store: Store, projectId: string | null, permissions: readonly string[], now: number, ttlMs: number): { readonly token: string; readonly expiresAt: number } {
  const token = `projectorch-control-${randomUUID()}`;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  store.db.prepare("INSERT INTO control_entries(token_hash,project_id,permissions_json,created_at,expires_at) VALUES(?,?,?,?,?)").run(tokenHash, projectId ?? '*', JSON.stringify(permissions), now, now + ttlMs);
  return { token, expiresAt: now + ttlMs };
}

export function authenticateControlEntry(store: Store, token: string, now: number): ControlPrincipal | null {
  if (typeof token !== 'string' || !token.startsWith('projectorch-control-')) return null;
  const row = store.db.prepare("SELECT token_hash,project_id,permissions_json,expires_at,revoked_at FROM control_entries WHERE token_hash=?").get(createHash('sha256').update(token).digest('hex')) as { token_hash: string; project_id: string; permissions_json: string; expires_at: number; revoked_at: number | null } | undefined;
  if (!row || row.expires_at <= now || row.revoked_at !== null) return null;
  return { kind: 'control_entry', principalId: `control-${String(row.token_hash)}`, projectId: row.project_id === '*' ? null : row.project_id, permissions: JSON.parse(String(row.permissions_json)) };
}

/** 控制主体backend：MCP连接的工具面（意图工具+读）——经授权核验后转发到生产命令管线 */
/** 写类工具所需权限（复核准入收紧）：permissions=[]只可读（identity/projects/operation_status）。 */
const TOOL_PERMISSIONS: Readonly<Record<string, string>> = Object.freeze({
  projectorch_project_create:'project.bootstrap',
  projectorch_adopt_conversation: 'project.bootstrap',
  projectorch_startup_ack: 'project.bootstrap',
  projectorch_project_bootstrap: 'project.bootstrap',
  projectorch_message_send: 'message.send',
  projectorch_task_dispatch: 'task.dispatch',
  projectorch_task_rework: 'task.rework',
});

const bootstrapRolesSchema={type:'array',maxItems:128,items:{type:'object',properties:{roleId:{type:'string',minLength:1,maxLength:128},name:{type:'string',minLength:1,maxLength:512},harnessId:{type:'string',enum:['codex','zcode']},charter:{type:'string',minLength:1,maxLength:16384},permissionProfileId:{type:'string',minLength:1,maxLength:128},parentRoleId:{type:'string',minLength:1,maxLength:128},createSession:{type:'boolean'}},required:['roleId'],additionalProperties:false}};
function validateBootstrapArguments(args:Record<string,unknown>):void{
  const top=new Set(['projectId','objective','roles','harnessId','workspaceRoot']);
  if(Object.keys(args).some(k=>!top.has(k))||typeof args.objective!=='string'||!args.objective||args.objective.length>8192)throw new Error('BOOTSTRAP_ARGUMENTS_INVALID');
  if(args.roles===undefined)return;
  if(!Array.isArray(args.roles)||args.roles.length>128)throw new Error('BOOTSTRAP_ARGUMENTS_INVALID');
  const ids=new Set<string>();
  for(const value of args.roles){
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('BOOTSTRAP_ARGUMENTS_INVALID');
    const role=value as Record<string,unknown>;
    if(Object.keys(role).some(k=>!Object.hasOwn(bootstrapRolesSchema.items.properties,k))||typeof role.roleId!=='string'||!role.roleId||role.roleId.length>128||ids.has(role.roleId))throw new Error('BOOTSTRAP_ARGUMENTS_INVALID');
    ids.add(role.roleId);
    for(const [key,limit] of [['name',512],['charter',16384],['permissionProfileId',128],['parentRoleId',128]] as const){if(role[key]!==undefined&&(typeof role[key]!=='string'||!role[key]||role[key].length>limit))throw new Error('BOOTSTRAP_ARGUMENTS_INVALID');}
    if(role.harnessId!==undefined&&!['codex','zcode'].includes(String(role.harnessId)))throw new Error('BOOTSTRAP_ARGUMENTS_INVALID');
    if(role.createSession!==undefined&&typeof role.createSession!=='boolean')throw new Error('BOOTSTRAP_ARGUMENTS_INVALID');
  }
}

/** 控制主体backend：MCP连接的工具面（意图工具+读）——经授权核验后转发到生产命令管线。
 * 复核修复：逐请求重验（撤销/TTL立即生效不缓存主体）；项目范围与工具权限逐调用校验。 */
export function controlEntryBackend(store: Store, token: string, services: { readonly now: () => number }, orchestration: OrchestrationTools, hooks?: { readonly onOperationPolled?: (operationId: string) => void; readonly onAdopted?: (target: SessionRef) => void; readonly officialObserve?: (target: SessionRef) => Promise<boolean> }): McpBackendLike {
  let principal: ControlPrincipal | null = null;
  let everAuthenticated = false;
  const ensureAuth = (): ControlPrincipal => {
    // 逐请求重验DB（撤销/过期同一连接立即失效）——principal只作最近一次观察，不作为信任依据
    const current = authenticateControlEntry(store, token, services.now());
    if (!current) {
      // 曾配对后被撤销/过期：受控失败（不伪装成功，也不当从未配对抛协议错误）；从未配对：协议级UNBOUND
      if (everAuthenticated) throw new Error('CONTROL_ENTRY_UNBOUND_CONTROLLED');
      throw new Error('CONTROL_ENTRY_UNBOUND');
    }
    everAuthenticated = true;
    principal = current;
    return current;
  };
  /** 项目范围：scope主体只能操作自己项目（缺省回填scope项目）；全局主体须显式传projectId。 */
  const scopedProjectId = (p: ControlPrincipal, argsProjectId: unknown): string => {
    if (p.projectId !== null) {
      if (argsProjectId === undefined || argsProjectId === null || argsProjectId === '') return p.projectId;
      if (String(argsProjectId) !== p.projectId) throw new Error('CONTROL_ENTRY_PROJECT_SCOPE_VIOLATION');
      return p.projectId;
    }
    const id = String(argsProjectId ?? '');
    if (!id) throw new Error('CONTROL_ENTRY_PROJECT_REQUIRED');
    return id;
  };
  const assertPermission = (p: ControlPrincipal, tool: string): void => {
    const required = TOOL_PERMISSIONS[tool];
    if (required && !p.permissions.includes(required)) throw new Error(`CONTROL_ENTRY_PERMISSION_DENIED:${required}`);
  };
  return {
    list: () => [
      {name:'projectorch_project_create',description:'配对全局控制入口按既有项目创建合同登记本机项目与显式初始策略。hostId取identity.kernelHostId；返回receipt.projectId用于后续建组。不会自动修改已有策略，普通受管角色没有此工具。initialPolicy应遵守用户预算/权限，严格模型仍可能不可用。',inputSchema:toolArgumentSchema('project-create')},
      { name: 'projectorch_identity', description: '控制入口身份（未绑定返回unbound）', inputSchema: { type: 'object', properties: {} } },
      { name: 'projectorch_projects', description: '列出授权项目', inputSchema: { type: 'object', properties: {} } },
      { name: 'projectorch_adopt_conversation', description: '接纳已有对话为负责人（保留原生ID，不建替代会话；接纳后须完成启动握手）', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, roleId: { type: 'string' }, nativeSession: { type: 'object' } }, required: ['projectId', 'roleId', 'nativeSession'] } },
      { name: 'projectorch_startup_ack', description: '启动握手（provisioning→ready；六类版本取DB当前值校验）', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, roleId: { type: 'string' } }, required: ['projectId', 'roleId'] } },
      { name: 'projectorch_project_bootstrap', description: '在已登记项目内建立团队；先用project_create获得projectId。permissionProfileId选择项目已有档案（省略按team）；createSession=false仅登记待接纳的原负责人，不创建替代会话。已有角色配置变化须走管理变更，不能通过重试悄悄改职责。', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, objective: { type: 'string',minLength:1,maxLength:8192 }, roles:bootstrapRolesSchema,harnessId:{type:'string',enum:['codex','zcode']},workspaceRoot:{type:'string'} }, required: ['objective'],additionalProperties:false } },
      { name: 'projectorch_message_send', description: '跨端消息（重试沿用requestId；再次发送相同正文使用新requestId；旧客户端未给键时沿用正文去重）', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, toRoleId: { type: 'string' }, body: { type: 'string' }, requestId: { type: 'string', minLength: 1, maxLength: 256 }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['toRoleId', 'body'] } },
      { name: 'projectorch_task_dispatch', description: '任务派发意图（全局控制码须传projectId）', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, taskId: { type: 'string' } }, required: ['taskId'] } },
      { name: 'projectorch_task_rework', description: '返工重开（复核拒绝后blocked→ready；管理动作，审计留痕）', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, taskId: { type: 'string' } }, required: ['projectId', 'taskId'] } },
      { name: 'projectorch_operation_status', description: '查询持久操作进度（operationId）', inputSchema: { type: 'object', properties: { operationId: { type: 'string' } }, required: ['operationId'] } },
    ],
    call: (name: string, args: Record<string, unknown>) => {
      if (name === 'projectorch_identity') {
        const p = authenticateControlEntry(store, token, services.now());
        principal = p;
        return { ok: true, payload: p ? { kind: p.kind, principalId: p.principalId, projectId: p.projectId, kernelHostId:hostname(), sourceIdentity:'unknown', note: '控制入口主体（配对建立）；内核主机信息不证明原生聊天来源' } : { kind: 'unbound', note: '未配对连接——请从内核启动器获取控制码' } };
      }
      try {
      const p = ensureAuth();
      assertPermission(p, name);
      if(name==='projectorch_project_create'){
        if(p.projectId!==null)throw new Error('GLOBAL_CONTROL_REQUIRED');
        const input=parseToolArguments('project-create','',args);
        return {ok:true,payload:createProjectForUser(store,p.principalId,hostname(),{...input,schemaVersion:2},services.now(),()=>{const current=ensureAuth();assertPermission(current,name);if(current.projectId!==null||current.principalId!==p.principalId)throw new Error('GLOBAL_CONTROL_REQUIRED');})};
      }
      if (name === 'projectorch_projects') {
        const projects = p.projectId === null
          ? store.db.prepare("SELECT id,name FROM projects ORDER BY id").all()
          : store.db.prepare("SELECT id,name FROM projects WHERE id=? ORDER BY id").all(p.projectId);
        return { ok: true, payload: { projects } };
      }
      if (name === 'projectorch_adopt_conversation') {
        try {
          const result = adoptExistingConversation(store, { projectId: scopedProjectId(p, args.projectId), roleId: String(args.roleId ?? ''), nativeSession: args.nativeSession as never, principal: p }, services.now());
          // 复核批次一：接纳即触发官方会话观察核验（异步钩子——通过后标记verified，startup_ack放行；不依赖"发完消息"解环）
          if (hooks?.onAdopted) { try { hooks.onAdopted(parseSessionRef(args.nativeSession)); } catch { /* 核验尽力，不阻断接纳登记 */ } }
          return { ok: true, payload: { ...result, note: '已有对话接纳——保留原生ID未建替代会话；官方会话观察核验已异步触发，通过后 startup_ack 放行（未通过保持provisioning可重试）' } };
        } catch (error) { return { ok: false, payload: { error: String((error as Error).message).slice(0, 160) } }; }
      }
      if (name === 'projectorch_startup_ack') {
        try {
          const projectId = scopedProjectId(p, args.projectId);
          const roleId = String(args.roleId ?? '');
          // 复核批次一：adopt来源核验=接纳时异步官方观察（onAdopted钩子）——ack处仅执行门禁（未核验拒，核验完成后重试本操作即放行）
          const acked = completeBindingStartupAck(store, projectId, roleId);
          return { ok: true, payload: { roleId: acked?.id ?? roleId, note: 'startup-ack完成（六类版本=DB当前值校验；adopt来源经官方会话观察核验后放行）' } };
        } catch (error) { return { ok: false, payload: { error: String((error as Error).message).slice(0, 160), hint: 'adopt来源未核验会被拒——官方观察核验由接纳触发异步执行，稍后重试；未通过/未注入保持provisioning' } }; }
      }
      if (name === 'projectorch_project_bootstrap') {validateBootstrapArguments(args);return orchestration.projectBootstrap(store, p, { ...args, projectId: scopedProjectId(p, args.projectId) });}
      if (name === 'projectorch_message_send') return orchestration.messageSend(store, p, { ...args, projectId: scopedProjectId(p, args.projectId) });
      if (name === 'projectorch_task_dispatch') return orchestration.taskDispatch(store, p, { ...args, projectId: scopedProjectId(p, args.projectId) });
      if (name === 'projectorch_task_rework') {
        try {
          const reopened = reopenBlockedTask(store, scopedProjectId(p, args.projectId), String(args.taskId ?? ''), services.now());
          return { ok: true, payload: { taskId: reopened.id, state: reopened.state, revision: reopened.revision, note: '返工重开blocked→ready（task.reopened审计）' } };
        } catch (error) { return { ok: false, payload: { error: String((error as Error).message).slice(0, 160) } }; }
      }
      if (name === 'projectorch_operation_status') {
        // 复核修复：读纯读——查询不再触发投递泵（副作用移到事件/显式驱动）；操作按项目范围校验（scope主体不可读他项目操作）
        const op = readOperation(store, String(args.operationId ?? ''));
        if (!op) return { ok: false, payload: { error: 'OPERATION_NOT_FOUND' } };
        const opProjectId = String((op as { projectId?: unknown }).projectId ?? '');
        if (p.projectId !== null && opProjectId !== p.projectId) return { ok: false, payload: { error: 'OPERATION_PROJECT_SCOPE_VIOLATION' } };
        return { ok: true, payload: op };
      }
      return { ok: false, payload: { error: 'TOOL_UNKNOWN' } };
      } catch (error) {
        // 仅"从未配对"（CONTROL_ENTRY_UNBOUND）抛协议级错误由宿主转连接错误；
        // 其余一切（撤销/越权/超范围/业务错误）受控返回ok:false——拒绝同样生效且不崩复核/调用方。
        const message = String((error as Error).message);
        if (message === 'CONTROL_ENTRY_UNBOUND') throw error;
        return { ok: false, payload: { error: message.slice(0, 160) } };
      }
    },
    closed: () => { principal = null; },
  };
}

export interface McpBackendLike {
  list(): readonly unknown[];
  call(name: string, args: unknown): { readonly ok: boolean; readonly payload: unknown };
  closed(): void;
}

export interface OrchestrationTools {
  projectBootstrap(store: Store, principal: ControlPrincipal, args: Record<string, unknown>): { ok: boolean; payload: unknown };
  messageSend(store: Store, principal: ControlPrincipal, args: Record<string, unknown>): { ok: boolean; payload: unknown };
  taskDispatch(store: Store, principal: ControlPrincipal, args: Record<string, unknown>): { ok: boolean; payload: unknown };
}

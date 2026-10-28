import {safeExecutionDiagnostic} from '../native/execution-diagnostics.js';
import {executionTimeout, rpcRequestTimeout, type ExecutionTimeoutOptions} from '../native/execution-timeout.js';
import {interruptNativeWritesWithin} from '@projectorch/domain/workspaces';
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdirSync, realpathSync, existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { startKernel, type StartResult, type KernelOptions } from "./kernel-runtime.js";
import { createCommandRunner } from "../commands/index.js";
import { commandErrorStatus } from "../commands/lifecycle-services.js";
import { userCommandServices } from "../commands/user-review.js";
import { controlEntryBackend, issueControlEntryToken, type OrchestrationTools } from "../auth/control-entry.js";
import {advanceQuestionWorkflow} from '../execution/question-continuation.js';
import { projectBootstrapOrchestration, messageSendOrchestration, taskDispatchOrchestration, recordStep,quiesceFactoryOrchestrations,settleFactoryOrchestrations,detachFactoryOrchestrations,sealFactoryOrchestrations,type FactoryAdapter } from "../tools/orchestration-tools.js";
import {inspectCodexCharter} from '../native/factory-observation.js';
import { createZcodeWorkflowRuntime, detectZcodeIdentity } from "../execution/zcode-supervisor.js";
import { verifiedBindingCredential } from "../auth/binding-credentials.js";
import { buildRoleToolBackend } from "../tools/role-tool-backend.js";
import {issueRoleTurnCredential} from '../auth/role-turn-credential.js';
import {authenticateAgentCredential} from '../auth/agent-credential.js';
import {pumpRoleProvisioning,settleRoleProvisioning,detachRoleProvisioning,sealRoleProvisioning} from '../tools/role-provisioning.js';
import {markUncertainDelivery} from '@projectorch/domain/messages';
import type { McpBackend } from "../tools/mcp-http-host.js";
import { pumpMessageDelivery, type NativeTurnReceipt, type DeliveryTarget } from "../execution/message-delivery.js";
import { ZCodeTextProcess } from "../native/zcode-text-process.js";
import { NativeCompatibilityRegistry } from "../native/compatibility.js";
import { gateStartupIdentity, loadCompatibilityMatrix } from "../doctor/index.js";
import { NativeRpcError } from "../native/stdio-peer.js";
import { writeBindingToolConfig, codexRoleToolOverrides } from '../tools/binding-tool-config.js';
import { assertMessageSenderAuthorized } from '../execution/message-authorization.js';
import { NativeSessionLease } from '../native/session-lease.js';
import { ensureBindingWorkspace, bindingWorkspaceDirectory } from '../execution/binding-workspace.js';
import { readProjectPolicy } from '../auth/project-policy.js';
import { toolAction } from '../tools/gateway-tools.js';
import { mcpToolEntries } from '../tools/mcp-catalog.js';
import { bindingForSession,bindingModelSelection } from '../execution/binding-model-selection.js';
import { applyZcodeModelSelection } from '../native/model-selection.js';
import {readNativeConversation} from '../native/conversation-reader.js';
import {recoverInterruptedCodexMessage} from '../execution/message-negative-recovery.js';

/** 复核批次一：zcode环境完备化——非Desktop宿主（外部启动器/codex exec等）无 ZCODE_* 继承时，
 * 按 Desktop 标准数据布局（%APPDATA%/SPB_Data）补默认值；显式传入优先；不读取认证内容（路径指给官方CLI自用）。 */
export function completeZcodeEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const completed: Record<string, string> = { ...env };
  const dataBase = completed.ZCODE_DATA_BASE_DIR ?? path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "SPB_Data");
  completed.ZCODE_DATA_BASE_DIR ??= dataBase;
  if (!completed.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE) {
    const personal = path.join(dataBase, ".zcode", "v2", "provider_config.json");
    if (existsSync(personal)) completed.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personal;
  }
  if (!completed.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) {
    const providerRoot = path.join(dataBase, ".zcode", "v2", "runtime", "provider", "windows-x86_64");
    if (existsSync(providerRoot)) {
      const versions = readdirSync(providerRoot).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const latest = versions.at(-1);
      if (latest) {
        const endpointDir = path.join(providerRoot, latest);
        const endpoints = readdirSync(endpointDir).filter(d => /^endpoint-/.test(d));
        const endpoint = endpoints.at(-1);
        const builtin = endpoint ? path.join(endpointDir, endpoint, "zcode-builtin.json") : null;
        if (builtin && existsSync(builtin)) completed.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtin;
      }
    }
  }
  completed.ZCODE_BASE_URL ??= "https://zcode.z.ai";
  completed.ZCODE_ENV ??= "production";
  return completed;
}

/** Codex专用隔离环境（HOME/CODEX_HOME等指向profileDirectory——不继承宿主凭据目录；与A112探针同一隔离约定）。
 * sharedLogin=true（受信启动器显式声明）：CODEX_HOME保持用户原值（共享真实登录，如真实工作环境测试），
 * 仍不读取/不复制凭据内容——进程环境由官方CLI自身使用；cwd/TEMP仍指向专用目录避免写污染宿主。 */
function buildCodexEnv(profileDirectory: string, sharedLogin = false): { readonly env: Readonly<Record<string, string>>; readonly cwd: string } {
  if (sharedLogin) {
    const env: Record<string, string> = {};
    for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOME", "CODEX_HOME"]) { const v = process.env[key]; if (v) env[key] = v; }
    const cwd = path.join(profileDirectory, "shared-ws");
    mkdirSync(cwd, { recursive: true });
    return { env: Object.freeze(env), cwd };
  }
  const env: Record<string, string> = {};
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'COMSPEC']) if (process.env[key]) env[key] = process.env[key];
  for (const [k, v] of Object.entries({ HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata', TEMP: 'tmp', TMP: 'tmp', CODEX_HOME: 'codex', XDG_CONFIG_HOME: 'home/.config', XDG_DATA_HOME: 'home/.local/share' })) env[k] = path.join(profileDirectory, v);
  const cwd = path.join(profileDirectory, 'workspace');
  mkdirSync(path.join(profileDirectory, 'tmp'), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { env: Object.freeze(env), cwd };
}

export interface StartApplicationOptions {
  /** 受信启动器提供的原生执行环境；缺省时MCP入口与工作流仍启动（编排操作停在unknown/等待绑定）。 */
  readonly native?: {
    readonly zcode?: ExecutionTimeoutOptions & { readonly executable: string; readonly bundle: string; readonly env: Readonly<Record<string, string>>; readonly leaseDirectory: string; readonly timeoutMs?: number };
    /** Codex官方app-server执行环境（专用隔离profile——HOME/CODEX_HOME等指向profileDir，不继承宿主凭据目录）。
     * sharedLogin=true：受信启动器显式声明共享用户真实登录（CODEX_HOME保持原值；真实工作环境测试用）。 */
    readonly codex?: ExecutionTimeoutOptions & { readonly rpcTimeoutMs?: number; readonly executable: string; readonly profileDirectory: string; readonly leaseDirectory: string; readonly timeoutMs?: number; readonly sharedLogin?: boolean };
    readonly workspaceForTask?: (projectId: string, taskId: string, bindingId: string) => string;
  };
  readonly workflowPollMs?: number;
  /** 受信本地关闭观察期，缺省30秒；不是原生执行的取消/完成期限。 */
  readonly shutdownDrainMs?:number;
  /** T051：兼容矩阵路径（身份→能力实测证据）；缺省解析仓库根 config/compatibility.json，可显式覆盖（测试/打包布局）。 */
  readonly compatibilityMatrixPath?: string;
}

/** DR01：标准启动即装配MCP控制入口+意图工具+（配置原生环境时）真实工作流。
 * 控制码写入数据目录control-entry.json（受信本地文件，不入日志/模型正文）。 */
export interface ApplicationRuntime extends StartResult {recoverInterruptedMessage(projectId:string,messageId:string):ReturnType<typeof recoverInterruptedCodexMessage>;}
export async function startApplication(dataDirectory: string, options: StartApplicationOptions = {}): Promise<ApplicationRuntime> {
  for(const native of [options.native?.zcode,options.native?.codex])if(native)executionTimeout(native);
  if(options.native?.codex)rpcRequestTimeout(options.native.codex.rpcTimeoutMs);
  if(options.native)options={...options,native:{...options.native,...(options.native.zcode?{zcode:{...options.native.zcode,timeoutMs:executionTimeout(options.native.zcode)}}:{}),...(options.native.codex?{codex:{...options.native.codex,timeoutMs:executionTimeout(options.native.codex)}}:{})}};
  const shutdownDrainMs=options.shutdownDrainMs??30000;if(!Number.isSafeInteger(shutdownDrainMs)||shutdownDrainMs<1||shutdownDrainMs>300000)throw Error('INVALID_SHUTDOWN_DRAIN_TIMEOUT');
  if (!path.isAbsolute(dataDirectory) || /^(?:\\\\|\/\/)/.test(dataDirectory)) throw new Error("LOCAL_DATA_DIRECTORY_REQUIRED");
  const webDistDir = fileURLToPath(new URL("../../../web/dist/", import.meta.url));
  if (!existsSync(path.join(webDistDir, "index.html"))) throw new Error("WEB_BUILD_REQUIRED");
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const directory = realpathSync(dataDirectory);
  for (const native of [options.native?.zcode, options.native?.codex]) if (native) NativeSessionLease.prepareDirectory(native.leaseDirectory);
  const principalId = `local-user-${createHash("sha256").update(directory).digest("hex").slice(0, 32)}`;
  // DR01：MCP入口+意图工具（标准启动默认启用——控制主体经一次性控制码授权）
  const registry = new NativeCompatibilityRegistry();
  const orchestration = {} as OrchestrationTools; // 由下方闭包填充（store可用后）
  let runtimeRef: StartResult | null = null;
  let applicationStopping=false;
  let observationDetached=false;
  const guardBackend=(backend:McpBackend):McpBackend=>({list:()=>applicationStopping?[]:backend.list(),call:(name,args)=>applicationStopping?{ok:false,payload:{error:'KERNEL_STOPPING'}}:backend.call(name,args),closed:()=>backend.closed?.()});
  const workspaceDirectoryFor = (projectId: string, taskId: string, bindingId: string): string => {
    if(options.native?.workspaceForTask)return options.native.workspaceForTask(projectId,taskId,bindingId);
    if(!runtimeRef)throw new Error('KERNEL_NOT_READY');
    return bindingWorkspaceDirectory(runtimeRef.store,projectId,bindingId,false);
  };
  let triggerDeliveryPump: () => void = () => { throw new Error('KERNEL_NOT_READY'); };
  let officialObserve: (target: DeliveryTarget) => Promise<boolean> = async () => false;
  let injectToolEntry: (bindingId: string, roleId: string, harnessId: string, workspaceRoot: string) => void = () => { throw new Error('KERNEL_NOT_READY'); };
  const codexRoleTools = (bindingId: string): { env: Record<string, string>; configOverrides: readonly string[]; hostId: string; profileId: string } => {
    if (!runtimeRef?.mcpEntrypoint) throw new Error('KERNEL_NOT_READY');
    const st = runtimeRef.store;
    const row = st.db.prepare('SELECT s.harness_id AS h,s.host_id AS ho,s.profile_id AS p,s.native_conversation_id AS n,s.native_workspace_id AS w,b.epoch AS e FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.id=? AND b.ended_at IS NULL').get(bindingId) as {h:string;ho:string;p:string;n:string;w:string|null;e:number}|undefined;
    if (!row || row.h !== 'codex') throw new Error('CODEX_BINDING_REQUIRED');
    const credential = verifiedBindingCredential(st, path.join(directory,'binding-credentials.json'),bindingId,{harnessId:row.h,hostId:row.ho,profileId:row.p,nativeConversationId:row.n,...(row.w?{nativeWorkspaceId:row.w}:{})},Number(row.e),Date.now());
    const role=st.db.prepare('SELECT b.project_id,r.permission_profile,r.permission_profile_revision FROM role_bindings b JOIN roles r ON r.id=b.role_id AND r.project_id=b.project_id WHERE b.id=? AND b.ended_at IS NULL').get(bindingId);
    if(!role)throw new Error('BINDING_NOT_FOUND');
    const profile=readProjectPolicy(st.db,String(role.project_id)).profiles.find(p=>p.id===role.permission_profile&&p.revision===role.permission_profile_revision);
    if(!profile)throw new Error('POLICY_PROFILE_REVISION_CONFLICT');
    // 只对当前档案已授权的本内核工具使用官方逐工具预授权；内核仍逐请求核销，其他MCP/命令策略不变。
    const tools=mcpToolEntries.filter(e=>profile.actions.includes(toolAction(e.tool)?.action??'')).map(e=>e.name);
    return {env:{PROJECTORCH_ROLE_CREDENTIAL:credential},configOverrides:codexRoleToolOverrides(runtimeRef.mcpEntrypoint.url,tools),hostId:row.ho,profileId:row.p};
  };
  // 控制码：每数据目录一个持久控制码（启动前生成；存受信本地文件）
  const controlToken = (() => {
    const p = path.join(directory, 'control-entry.json');
    try { const saved = JSON.parse(readFileSync(p, 'utf8')) as { token: string }; if (saved.token) return saved.token; } catch { /* 首启动 */ }
    const token = `projectorch-control-${randomUUID()}${randomUUID()}`; // 复核修复：随机控制码——不可从目录名推导（写入受信本地文件，不入日志/模型正文）
    writeFileSync(p, JSON.stringify({ token, note: '受信本地控制码——两Harness官方MCP配置引用；不入日志/模型正文' }) + String.fromCharCode(10), { mode: 0o600 });
    return token;
  })();
  const backendForConnection = () => {
    const runtime = runtimeRef;
    if (!runtime) return { list: () => [], call: () => ({ ok: false, payload: { error: 'KERNEL_NOT_READY' } }), closed: () => {} };
    return guardBackend(controlEntryBackend(runtime.store, controlToken, { now: () => Date.now() }, orchestration, {
      // 轮询message.send操作时顺带触发一次投递泵（拉取停滞消息重试——harness驱动的进度模型）
      onOperationPolled: () => { triggerDeliveryPump(); },
      // 复核批次一：接纳触发官方会话观察核验（异步）——通过标记verified（startup_ack随后放行）；未通过留provisioning可重试
      onAdopted: (target) => { void officialObserve({ ...target, workspaceRoot: target.nativeWorkspaceId??'.' }).then(async observed => {
        if (!observed || !runtime.isOwner()) return;
        const binding=runtime.store.db.prepare('SELECT b.id,b.role_id FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.ended_at IS NULL AND s.harness_id=? AND s.host_id=? AND s.profile_id=? AND s.native_conversation_id=? AND COALESCE(s.native_workspace_id,?)=?').get(target.harnessId,target.hostId,target.profileId,target.nativeConversationId,'',target.nativeWorkspaceId??'');
        if(!binding)return;
        // 官方观察通过后仍需工具入口成功；失败保留provisioning，重放接纳可重试同绑定。
        injectToolEntry(String(binding.id),String(binding.role_id),target.harnessId,target.nativeWorkspaceId??'.');
        const { markNativeSessionVerified } = await import("@projectorch/domain/messages");
        if(runtime.isOwner())markNativeSessionVerified(runtime.store, target);
      }).catch(() => { /* 未核验/注入失败保持provisioning */ }); },
    }));
  };
  // T110：受管角色主体HTTP路由——agent凭据→角色工具面（共享生产模块）
  const resolveBearer = (token: string): McpBackend | null => {
    const runtime = runtimeRef;
    if (!runtime) return null;
    const backend=buildRoleToolBackend(runtime.store, token);return backend?guardBackend(backend):null;
  };
  const kernelOptions: Record<string, unknown> = {
    filename: path.join(directory, "state.sqlite"), principalId, webDistDir,
    readConversation:async(session:import('@projectorch/adapter-contract').SessionRef,assertCurrent:()=>void)=>{
      const guard=()=>{if(applicationStopping||!runtimeRef?.isOwner())throw Error('KERNEL_NOT_AVAILABLE');assertCurrent();};guard();
      if(!session.nativeWorkspaceId||!path.isAbsolute(session.nativeWorkspaceId))throw Error('CONVERSATION_WORKSPACE_REQUIRED');
      if(session.harnessId==='codex'&&options.native?.codex){
        const {detectCodexIdentity}=await import('../execution/codex-supervisor.js'),config=options.native.codex,identity={harnessId:'codex' as const,...detectCodexIdentity(config.executable),bundleSha256:null,adapterProtocol:'codex-app-server-jsonl-v2',route:'official_rpc' as const};
        if(!registry.decide(identity,'historyRead').enabled)throw Error('CONVERSATION_CAPABILITY_UNVERIFIED');
        return readNativeConversation({executable:config.executable,env:buildCodexEnv(config.profileDirectory,config.sharedLogin===true).env,cwd:session.nativeWorkspaceId},session,guard);
      }
      if(session.harnessId==='zcode'&&options.native?.zcode){
        const config=options.native.zcode,identity={harnessId:'zcode' as const,...detectZcodeIdentity(config.executable,config.bundle),adapterProtocol:'zcode-cli-jsonl-v2',route:'official_cli' as const};
        if(!registry.decide(identity,'historyRead').enabled)throw Error('CONVERSATION_CAPABILITY_UNVERIFIED');
        return readNativeConversation({...config,cwd:session.nativeWorkspaceId},session,guard);
      }
      throw Error('CONVERSATION_RUNTIME_NOT_CONFIGURED');
    },
    stopDrainMs:shutdownDrainMs,
    commandRunnerFactory: (s: Parameters<typeof createCommandRunner>[0]) => createCommandRunner(s, userCommandServices(s)), commandErrorStatus,
    mcpEntrypoint: { backendForConnection, initialToken: controlToken, resolveBearer, audit: (info: { readonly method: string; readonly path: string; readonly status: number; readonly connectionCount: number; readonly reason: string; readonly tool?: string }) => { try { appendFileSync(path.join(directory, 'mcp-audit.log'), JSON.stringify({ t: Date.now(), ...info }) + String.fromCharCode(10)); } catch { /* 审计尽力 */ } } },
  };
  // DR01：原生环境配置时装配真实工作流
  // T051：兼容矩阵（实测身份→能力证据）；缺省解析仓库根 config/compatibility.json（dist/lifecycle → 根），可显式指定。
  const matrixSource = options.compatibilityMatrixPath ?? fileURLToPath(new URL("../../../../config/compatibility.json", import.meta.url));
  const compatibilityMatrix = loadCompatibilityMatrix(matrixSource);
  // 复核批次一：zcode环境完备化（非Desktop宿主无ZCODE_*继承时按SPB_Data标准布局补默认）——在任何使用前完成
  if (options.native?.zcode) options = { ...options, native: { ...options.native, zcode: { ...options.native.zcode, env: completeZcodeEnv(options.native.zcode.env) } } };
  if (options.native?.zcode || options.native?.codex) {
    kernelOptions.workflowFactory = (store2: unknown, ctx: { now: () => number; isKernelOwner: () => boolean }) => {
      const st = store2 as import("@projectorch/persistence").Store;
      const credentialFile = path.join(directory, "binding-credentials.json");
      // 真实sessionForBinding：绑定→会话/工作区/受管主体凭据（凭据原文受信缓存，惰性签发）
      const sessionForBinding = (bindingId: string): { readonly session: import("@projectorch/adapter-contract").SessionRef; readonly workspaceRoot: string; readonly credential: string } => {
        const row = st.db.prepare("SELECT b.project_id AS project_id, b.epoch AS epoch, s.harness_id AS harness_id, s.host_id AS host_id, s.profile_id AS profile_id, s.native_conversation_id AS native_conversation_id, s.native_workspace_id AS native_workspace_id FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.id=? AND b.ended_at IS NULL").get(bindingId) as { project_id: string; epoch: number; harness_id: string; host_id: string; profile_id: string; native_conversation_id: string; native_workspace_id: string } | undefined;
        if (!row) throw new Error("BINDING_NOT_FOUND");
        const workspaceRoot = String(row.native_workspace_id ?? "") || workspaceDirectoryFor(String(row.project_id), "", bindingId);
        const session = { harnessId: row.harness_id, hostId: row.host_id, profileId: row.profile_id, nativeConversationId: row.native_conversation_id, ...(row.native_workspace_id ? {nativeWorkspaceId:row.native_workspace_id} : {}) } as const;
        // 认证预检+自愈重签：缓存凭据可能指向已随历史事务回滚消失的行
        const credential = verifiedBindingCredential(st, credentialFile, bindingId, session, Number(row.epoch), ctx.now());
        return { session, workspaceRoot, credential };
      };
      const workspaceIdForTask = (projectId: string, taskId: string, bindingId: string): string => {
        const { workspaceRoot } = sessionForBinding(bindingId);
        return ensureBindingWorkspace(st, projectId, taskId, bindingId, workspaceRoot, ctx.now());
      };
      const beforeTurn=async(session:import('@projectorch/adapter-contract').SessionRef,assertCurrent:()=>void,input?:unknown):Promise<void>=>{
        assertCurrent();const bindingId=bindingForSession(st,session),attemptId=(input as {attemptId?:unknown})?.attemptId;
        if(typeof attemptId!=='string')throw Error('ROLE_TURN_DISPATCH_REQUIRED');
        const credential=issueRoleTurnCredential(st,bindingId,attemptId,Date.now()),binding=st.db.prepare('SELECT project_id FROM role_bindings WHERE id=?').get(bindingId);
        writeBindingToolConfig(session.nativeWorkspaceId??'',String(binding?.project_id),bindingId,runtimeRef?.mcpEntrypoint?.url??'',credential);
        const selection=bindingModelSelection(st,bindingForSession(st,session));
        if(!selection)return;
        const zcode=options.native?.zcode;if(!zcode)throw new NativeRpcError('ZCODE_RUNTIME_NOT_CONFIGURED','not_sent');
        await applyZcodeModelSelection({...zcode,cwd:session.nativeWorkspaceId??''},session,selection,assertCurrent);
      };
      return createZcodeWorkflowRuntime(st, ctx, { ...(options.native?.zcode ? options.native.zcode : {}), workspaceForTask: workspaceIdForTask,beforeTurn,trustedLocalUserId:principalId }, sessionForBinding, registry, options.native?.codex ? (session, workspaceRoot) => {
        // 复核批次一：codex执行驱动配置（工作区按绑定工作区分离——不再共用shared-ws；env同建会话路径含sharedLogin语义）
        const codexEnv = buildCodexEnv(options.native!.codex!.profileDirectory, options.native!.codex!.sharedLogin === true);
        const bindingId=bindingForSession(st,session);
        const tools = codexRoleTools(bindingId);
        return { executable: options.native!.codex!.executable, env: {...codexEnv.env,...tools.env}, configOverrides:tools.configOverrides, prepareTurn:(input:unknown)=>{
          const attemptId=(input as {attemptId?:unknown})?.attemptId;if(typeof attemptId!=='string')throw Error('ROLE_TURN_DISPATCH_REQUIRED');
          const credential=issueRoleTurnCredential(st,bindingId,attemptId,Date.now());return {env:{...codexEnv.env,PROJECTORCH_ROLE_CREDENTIAL:credential},configOverrides:codexRoleTools(bindingId).configOverrides};
        },rpcTimeoutMs:rpcRequestTimeout(options.native?.codex?.rpcTimeoutMs),modelSelection:()=>bindingModelSelection(st,bindingId), cwd: workspaceRoot || codexEnv.cwd, leaseDirectory: options.native!.codex!.leaseDirectory, ...(options.native!.codex!.timeoutMs !== undefined ? { timeoutMs: options.native!.codex!.timeoutMs } : {}) };
      } : undefined);
    };
    kernelOptions.workflowPollMs = options.workflowPollMs ?? 1000;
  }
  if (options.native?.zcode) {
    // R043：启动现场身份重核+受信能力登记——T051起经兼容矩阵闸门：身份（版本+双哈希+协议）在矩阵内
    // 才登记矩阵结论（先前真实探针证据）；漂移→不登记，工厂与投递按unverified拒绝（不凭上次成功永久verified）。
    const detected = detectZcodeIdentity(options.native!.zcode!.executable, options.native!.zcode!.bundle);
    const zcodeGate = gateStartupIdentity(registry, compatibilityMatrix, matrixSource, { harnessId: 'zcode', version: detected.version, executableSha256: detected.executableSha256, bundleSha256: detected.bundleSha256, adapterProtocol: 'zcode-cli-jsonl-v2', route: 'official_cli' }, `kernel-startup-${Date.now().toString(36)}`);
    if (!zcodeGate.registered) console.warn(`[doctor] zcode身份漂移：版本${detected.version}不在兼容矩阵（${matrixSource}），zcode相关自动写动作停止，待复验能力=${zcodeGate.pendingReverify.join(',')}`);
  }
  if (options.native?.codex) {
    // R043：同上——Codex官方app-server身份现场重核+经矩阵闸门登记
    const { detectCodexIdentity } = await import("../execution/codex-supervisor.js");
    const codexDetected = detectCodexIdentity(options.native.codex.executable);
    const codexGate = gateStartupIdentity(registry, compatibilityMatrix, matrixSource, { harnessId: 'codex', version: codexDetected.version, executableSha256: codexDetected.executableSha256, bundleSha256: null, adapterProtocol: 'codex-app-server-jsonl-v2', route: 'official_rpc' }, `kernel-startup-codex-${Date.now().toString(36)}`);
    if (!codexGate.registered) console.warn(`[doctor] codex身份漂移：版本${codexDetected.version}不在兼容矩阵（${matrixSource}），codex相关自动写动作停止，待复验能力=${codexGate.pendingReverify.join(',')}`);
  }
  const runtime = await startKernel(kernelOptions as never);
  let pumpInterval: ReturnType<typeof setInterval> | undefined;
  try {
  runtimeRef = runtime;
  runtime.store.transaction(()=>interruptNativeWritesWithin(runtime.store,Date.now()));
  // 编排接线（store可用后）
  const rt = runtime as unknown as { store: import("@projectorch/persistence").Store };
  const factory: FactoryAdapter = {
    async observeBoundSession(session){
      const {inspectSessionQuiescence}=await import('../native/factory-observation.js');
      if(session.harnessId==='codex'&&options.native?.codex){
        const config=options.native.codex,environment=buildCodexEnv(config.profileDirectory,config.sharedLogin===true);
        return inspectSessionQuiescence({executable:config.executable,env:environment.env,cwd:session.nativeWorkspaceId??environment.cwd},session);
      }
      if(session.harnessId==='zcode'&&options.native?.zcode){const config=options.native.zcode;return inspectSessionQuiescence({executable:config.executable,bundle:config.bundle,env:config.env,cwd:session.nativeWorkspaceId??'.'},session);}
      return false;
    },
    async recoverBoundSession(input) {
      const prefix=input.steps.some(s=>['binding-registration','factory-call','session-identity'].some(name=>s.step===`role:${input.roleId}:`+name))?`role:${input.roleId}:`:'';
      let identity = [...input.steps].reverse().find(s => s.step===prefix+'session-identity' && s.state==='observed' && s.detail);
      let charter = input.steps.some(s => s.step===prefix+'deliver-charter' && s.state === 'observed');
      let nativeTurnId=input.steps.findLast(s=>s.step===prefix+'charter-execution'&&s.state==='observed'&&s.detail)?.detail??null;
      if(!nativeTurnId&&input.harnessId==='zcode')nativeTurnId=input.steps.findLast(s=>s.step===prefix+'deliver-charter'&&s.state==='observed'&&s.detail)?.detail??null;
      const history=input.steps.findLast(s=>s.step===prefix+'charter-history-proof'&&s.state==='observed'&&s.detail);if(!nativeTurnId&&history?.detail){const proof=JSON.parse(history.detail);if(typeof proof.executionId==='string')nativeTurnId=proof.executionId;}
      if((!identity?.detail||!charter||!nativeTurnId)&&input.harnessId==='codex'&&options.native?.codex){
        const ids=[...new Set(input.steps.filter(s=>s.step===prefix+'create-thread'&&s.state==='observed'&&s.detail).map(s=>s.detail!))];
        if(ids.length!==1)return null; // 无可信ID或歧义时不列线程、不按cwd猜测。
        const native=options.native.codex,{detectCodexIdentity}=await import('../execution/codex-supervisor.js'),detected=detectCodexIdentity(native.executable);
        const nativeIdentity={harnessId:'codex',...detected,bundleSha256:null,adapterProtocol:'codex-app-server-jsonl-v2',route:'official_rpc'} as const;
        if(!registry.decide(nativeIdentity,'historyRead').enabled)return null;
        const sessionRef={harnessId:'codex',hostId:'projectorch-local',profileId:'kernel-codex-factory',nativeConversationId:ids[0]!,nativeWorkspaceId:input.workspaceRoot};
        const role=rt.store.db.prepare('SELECT charter FROM roles WHERE id=? AND project_id=?').get(input.roleId,input.projectId);if(!role)return null;
        const marker=`CHARTER_OK_${input.roleId}`,expectedInput=`${input.charter??role.charter}\n\n收到本章程后只回复：${marker}`,env=buildCodexEnv(native.profileDirectory,native.sharedLogin===true).env;
        const proof=await inspectCodexCharter({executable:native.executable,env,cwd:input.workspaceRoot},sessionRef,expectedInput,marker);
        if(!proof||observationDetached||!runtime.isOwner())return null;
        try{NativeSessionLease.recoverAfterTerminal(native.leaseDirectory,sessionRef,proof);}catch{return null;}
        if(!await officialObserve({...sessionRef,workspaceRoot:input.workspaceRoot})||observationDetached||!runtime.isOwner())return null;
        const at=Date.now();for(const step of [{step:prefix+'session-identity',detail:JSON.stringify(sessionRef)},{step:prefix+'deliver-charter',detail:proof.executionId},{step:prefix+'charter-history-proof',detail:JSON.stringify({executionId:proof.executionId,inputSha256:proof.inputSha256,responseSha256:proof.responseSha256,identity:nativeIdentity})}])recordStep(rt.store,input.operationId,{...step,state:'observed',at},at);
        identity={step:prefix+'session-identity',detail:JSON.stringify(sessionRef),state:'observed',at};charter=true;nativeTurnId=proof.executionId;
      }
      if (!identity?.detail || !charter) return null;
      const sessionRef = JSON.parse(identity.detail) as import('@projectorch/adapter-contract').SessionRef;
      if (!await officialObserve({ ...sessionRef, workspaceRoot: sessionRef.nativeWorkspaceId??input.workspaceRoot })) return null;
      // 只接回已持久观察到的原生ID；缺创建/章程证据时不启动新会话。
      return { sessionRef, nativeSessionId: sessionRef.nativeConversationId, nativeTurnId, charterDelivered: true };
    },
    async ensureBoundSession(input) {
      const originalGuard=input.assertCanSend,originalStep=input.onStep;input={...input,assertCanSend:()=>{if(applicationStopping)throw new NativeRpcError('KERNEL_STOPPING','not_sent');originalGuard();},onStep:s=>{if(!observationDetached)originalStep(s);}};
      input.assertCanSend();
        const preference=rt.store.db.prepare('SELECT model_requested_json,model_preference_revision FROM roles WHERE id=? AND project_id=?').get(input.roleId,input.projectId);
      if(preference?.model_requested_json)throw new NativeRpcError('MODEL_FACTORY_SELECTION_NOT_VERIFIED','not_sent');
      // 双Harness工厂分发（场景二）：zcode=官方CLI持久会话；codex=官方app-server线程
      if (input.harnessId === 'codex') {
        if (!options.native?.codex) throw new NativeRpcError('CODEX_RUNTIME_NOT_CONFIGURED', 'not_sent');
        const { CodexThreadFactory, detectCodexIdentity } = await import("../execution/codex-supervisor.js");
        const { CodexAdapter } = await import("../adapters/codex-adapter.js");
        const codexEnvBase = buildCodexEnv(options.native.codex.profileDirectory, options.native.codex.sharedLogin === true);
        // 复核批次一：codex建会话工作区按绑定工作区分（shared-ws仅作回退）
        const codexWs = input.workspaceRoot && input.workspaceRoot !== '.' ? input.workspaceRoot : codexEnvBase.cwd;
        const codexEnv = { env: codexEnvBase.env, cwd: codexWs };
        const codexIdentity = detectCodexIdentity(options.native.codex.executable);
        const identity = { harnessId: 'codex', version: codexIdentity.version, executableSha256: codexIdentity.executableSha256, bundleSha256: null, adapterProtocol: 'codex-app-server-jsonl-v2', route: 'official_rpc' } as const;
        const adapter = new CodexAdapter({ rpcTimeoutMs: rpcRequestTimeout(options.native.codex.rpcTimeoutMs), executable: options.native.codex.executable, cwd: codexEnv.cwd, env: codexEnv.env, ...(options.native.codex.timeoutMs !== undefined ? { timeoutMs: options.native.codex.timeoutMs } : {}), leaseDirectory: options.native.codex.leaseDirectory, hostId: 'projectorch-local', profileId: 'kernel-codex-factory', compatibility: { registry, identity } });
        try {
          const charterFactory = new CodexThreadFactory({ executable: options.native.codex.executable, cwd: codexEnv.cwd, env: codexEnv.env, leaseDirectory: options.native.codex.leaseDirectory, registry, ...(options.native.codex.timeoutMs !== undefined ? { timeoutMs: options.native.codex.timeoutMs } : {}) });
          const marker = `CHARTER_OK_${input.roleId}`;
          const outcome = await charterFactory.createThreadWithCharter({ adapter, assertCanSend:input.assertCanSend, charter: `${input.charter}\n\n收到本章程后只回复：${marker}`, marker, hostId: 'projectorch-local', profileId: 'kernel-codex-factory', onStep: step=>{input.onStep(step);if(step.step==='create-thread'&&step.state==='observed'&&step.detail)input.onStep({step:'session-identity',state:'observed',detail:JSON.stringify({harnessId:'codex',hostId:'projectorch-local',profileId:'kernel-codex-factory',nativeConversationId:step.detail,nativeWorkspaceId:codexEnv.cwd}),at:Date.now()});} });
          const sessionRef={...outcome.sessionRef,nativeWorkspaceId:codexEnv.cwd};
          input.onStep({step:'session-identity',state:'observed',detail:JSON.stringify(sessionRef),at:Date.now()});
          input.onStep({step:'charter-execution',state:'observed',detail:outcome.nativeTurnId,at:Date.now()});
          return { sessionRef, nativeSessionId: outcome.nativeThreadId, nativeTurnId: outcome.nativeTurnId, charterDelivered: true };
        } catch (error) {
          const message = String((error as Error).message);
          // 部分成功语义：线程已真实创建（adapter.threadId权威观察）但章程轮失败（如额度耗尽）→登记线程、charterDelivered=false
          const threadId = adapter.threadId;
          if (threadId && /FACTORY_TURN_|FACTORY_MARKER|MARKER_NOT_OBSERVED|FACTORY_THREAD_MISMATCH/.test(message)) {
            input.onStep({ step: 'thread-partial', state: 'failed', detail: message.slice(0, 120), at: Date.now() });
            const sessionRef={harnessId:'codex',hostId:'projectorch-local',profileId:'kernel-codex-factory',nativeConversationId:threadId,nativeWorkspaceId:codexEnv.cwd};
            input.onStep({step:'session-identity',state:'observed',detail:JSON.stringify(sessionRef),at:Date.now()});
            return { sessionRef, nativeSessionId: threadId, nativeTurnId: null, charterDelivered: false };
          }
          throw error;
        } finally {
          try { await adapter.close(); } catch { /* 尽力释放 */ }
        }
      }
      // 生产：经ZcodeSessionFactory（真实原生环境未配置→unknown）
      if (!options.native?.zcode) throw new NativeRpcError('NATIVE_ENVIRONMENT_NOT_CONFIGURED', 'not_sent');
      const { ZcodeSessionFactory } = await import("../execution/zcode-supervisor.js");
      const f = new ZcodeSessionFactory({ executable: options.native.zcode.executable, bundle: options.native.zcode.bundle, env: options.native.zcode.env, leaseDirectory: options.native.zcode.leaseDirectory, registry, ...(options.native.zcode.timeoutMs !== undefined ? { timeoutMs: options.native.zcode.timeoutMs } : {}) });
      const outcome = await f.createSessionWithCharter({ assertCanSend:input.assertCanSend, charter: input.charter, workspaceRoot: input.workspaceRoot, hostId: 'local', profileId: 'orchestration', onStep: input.onStep });
      // 执行侧生效模型权威回写（roles.model_effective_json——监督总览"模型生效"真值来源）
      if (outcome.effectiveModel&&!observationDetached&&!rt.store.db.prepare('SELECT 1 FROM role_bindings WHERE project_id=? AND role_id=? AND ended_at IS NULL').get(input.projectId,input.roleId)) {
        try {
          const { recordModelEffective } = await import("@projectorch/domain/roles");
          const roleIdForEffective = typeof (input as { roleId?: unknown }).roleId === 'string' ? String((input as { roleId: string }).roleId) : null;
            if (roleIdForEffective) recordModelEffective(rt.store, String(input.projectId ?? ''), roleIdForEffective, { modelId: outcome.effectiveModel.modelId, providerId: outcome.effectiveModel.providerId, observedAt: Date.now(), basis: 'session-authoritative' },Number(preference?.model_preference_revision));
        } catch { /* 回写尽力 */ }
      }
      input.onStep({step:'session-identity',state:'observed',detail:JSON.stringify(outcome.sessionRef),at:Date.now()});
      input.onStep({step:'charter-execution',state:'observed',detail:outcome.nativeTurnId,at:Date.now()});
      return { sessionRef:outcome.sessionRef, nativeSessionId: outcome.nativeSessionId, nativeTurnId: outcome.nativeTurnId,charterDelivered:true,effectiveModel:outcome.effectiveModel };
    },
  };
  // 控制码登记（幂等：同token哈希只登记一次；自管理control_entries表）
  rt.store.transaction(db => {
    const tokenHash = createHash('sha256').update(controlToken).digest('hex');
    if (!db.prepare("SELECT 1 FROM control_entries WHERE token_hash=?").get(tokenHash)) {
      const now = Date.now();
      db.prepare("INSERT INTO control_entries(token_hash,project_id,permissions_json,created_at,expires_at) VALUES(?,?,?,?,?)").run(tokenHash, '*', JSON.stringify(['project.bootstrap', 'message.send', 'task.dispatch', 'task.rework']), now, now + 365 * 24 * 60 * 60 * 1000);
    }
  });
  const charterFor = (roleId: string): string => { const row = rt.store.db.prepare("SELECT charter FROM roles WHERE id=?").get(roleId) as { charter?: string } | undefined; return row?.charter ?? roleId; };
  // 场景一/二：消息真实投递泵（生产resume路径——zcode=官方CLI resume；codex=官方app-server线程轮次）
  const runInBinding = async (_bindingId: string, target: DeliveryTarget, input: string, assertCurrent: () => void,onTurnStarted:(harnessId:string,conversationId:string,turnId:string)=>void): Promise<NativeTurnReceipt> => {
    const originalGuard=assertCurrent;assertCurrent=()=>{if(applicationStopping)throw new NativeRpcError('KERNEL_STOPPING','not_sent');originalGuard();};assertCurrent();
    if (target.harnessId === 'codex') {
      if (!options.native?.codex) throw new NativeRpcError('CODEX_RUNTIME_NOT_CONFIGURED','not_sent');
      const { detectCodexIdentity } = await import("../execution/codex-supervisor.js");
      const { CodexAdapter } = await import("../adapters/codex-adapter.js");
      const codexEnv = buildCodexEnv(options.native.codex.profileDirectory, options.native.codex.sharedLogin === true);
      const codexDetected = detectCodexIdentity(options.native.codex.executable);
      const identity = { harnessId: 'codex', version: codexDetected.version, executableSha256: codexDetected.executableSha256, bundleSha256: null, adapterProtocol: 'codex-app-server-jsonl-v2', route: 'official_rpc' } as const;
      const tools = codexRoleTools(_bindingId);
      const adapter = new CodexAdapter({ rpcTimeoutMs: rpcRequestTimeout(options.native.codex.rpcTimeoutMs), executable: options.native.codex.executable, cwd: target.workspaceRoot || codexEnv.cwd, env: {...codexEnv.env,...tools.env}, configOverrides:tools.configOverrides, ...(options.native.codex.timeoutMs !== undefined ? { timeoutMs: options.native.codex.timeoutMs } : {}), leaseDirectory: options.native.codex.leaseDirectory, hostId: tools.hostId, profileId: tools.profileId, compatibility: { registry, identity } });
      try {
        const { runCodexMessageTurn } = await import("../execution/codex-message-turn.js");
        const selection=bindingModelSelection(rt.store,_bindingId);
        const turn = await runCodexMessageTurn(adapter, target.nativeConversationId, input, executionTimeout(options.native.codex), assertCurrent,selection??undefined,turnId=>onTurnStarted('codex',target.nativeConversationId,turnId));
        if (turn.status === 'completed') return { harnessId: 'codex', nativeConversationId: target.nativeConversationId, nativeTurnId: turn.turnId, status: 'completed', responseText: turn.text, exitConfirmed: true };
        if (turn.status === 'unknown') return { harnessId: 'codex', nativeConversationId: target.nativeConversationId, nativeTurnId: turn.turnId, status: 'unknown', responseText: '', exitConfirmed: false, failureCode: turn.diagnostics?.code??'CODEX_TURN_UNKNOWN', ...(turn.diagnostics?{diagnostics:turn.diagnostics}:{}) };
        return { harnessId: 'codex', nativeConversationId: target.nativeConversationId, nativeTurnId: turn.turnId, status: 'failed', responseText: '', exitConfirmed: true, failureCode: `CODEX_TURN_${turn.status.toUpperCase()}`, ...(turn.diagnostics?{diagnostics:safeExecutionDiagnostic(turn.diagnostics)}:{}) };
      } finally {
        try { await adapter.close(); } catch { /* 尽力释放 */ }
      }
    }
    if (target.harnessId !== 'zcode') throw new NativeRpcError('HARNESS_RUNTIME_NOT_CONFIGURED','not_sent');
    if (!options.native?.zcode) throw new NativeRpcError('NATIVE_ENVIRONMENT_NOT_CONFIGURED','not_sent');
    const identity = (() => { const detected = detectZcodeIdentity(options.native!.zcode!.executable, options.native!.zcode!.bundle); return { harnessId: 'zcode', version: detected.version, executableSha256: detected.executableSha256, bundleSha256: detected.bundleSha256, adapterProtocol: 'zcode-cli-jsonl-v2', route: 'official_cli' } as const; })();
    if (!registry.decide(identity, 'resume').enabled) throw new NativeRpcError('NATIVE_CAPABILITY_UNVERIFIED:resume','not_sent');
    const env: Record<string, string> = { ...options.native.zcode.env, NO_COLOR: '1', ZCODE_PROCESS_LABEL: `projectorch-delivery-${Date.now().toString(36)}` };
    const process = new ZCodeTextProcess({ executable: options.native.zcode.executable, bundle: options.native.zcode.bundle, cwd: target.workspaceRoot || '.', env, ...(options.native.zcode.timeoutMs !== undefined ? { timeoutMs: options.native.zcode.timeoutMs } : {}) });
    assertCurrent();
    const bindingSession=rt.store.db.prepare('SELECT s.harness_id AS h,s.host_id AS ho,s.profile_id AS p,s.native_conversation_id AS n,s.native_workspace_id AS w FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.id=? AND b.ended_at IS NULL').get(_bindingId) as {h:string;ho:string;p:string;n:string;w:string|null}|undefined;
    if(!bindingSession) throw new NativeRpcError('BINDING_NOT_FOUND','not_sent');
    const lease=NativeSessionLease.acquire(options.native.zcode.leaseDirectory,{harnessId:bindingSession.h,hostId:bindingSession.ho,profileId:bindingSession.p,nativeConversationId:bindingSession.n,...(bindingSession.w?{nativeWorkspaceId:bindingSession.w}:{})});
    try{
      const selection=bindingModelSelection(rt.store,_bindingId);
      if(selection)await applyZcodeModelSelection({...options.native.zcode,cwd:target.workspaceRoot??''},{harnessId:bindingSession.h,hostId:bindingSession.ho,profileId:bindingSession.p,nativeConversationId:bindingSession.n,...(bindingSession.w?{nativeWorkspaceId:bindingSession.w}:{})},selection,assertCurrent);
      assertCurrent();
      // 消息轮不继承已终态任务轮的范围凭据；仅在无任务占位且本实例取得租约后恢复绑定工具入口。
      const binding=rt.store.db.prepare('SELECT project_id,epoch FROM role_bindings WHERE id=? AND ended_at IS NULL').get(_bindingId);if(!binding)throw new NativeRpcError('BINDING_NOT_FOUND','not_sent');
      const ref={harnessId:bindingSession.h,hostId:bindingSession.ho,profileId:bindingSession.p,nativeConversationId:bindingSession.n,...(bindingSession.w?{nativeWorkspaceId:bindingSession.w}:{})};
      const credential=verifiedBindingCredential(rt.store,path.join(directory,'binding-credentials.json'),_bindingId,ref,Number(binding.epoch),Date.now());
      writeBindingToolConfig(target.workspaceRoot??'.',String(binding.project_id),_bindingId,runtimeRef?.mcpEntrypoint?.url??'',credential);
      assertCurrent();
    }catch(error){lease.releaseAfterExit(true);throw error;}
    // 异常时保留owner占位供权威核对，不能按PID/时间抢占。
    const executionStartedAt=Date.now();
    let receipt:Awaited<ReturnType<ZCodeTextProcess['execute']>>;
    try{receipt=await process.execute(input,target.nativeConversationId,undefined,(sessionId,turnId)=>onTurnStarted('zcode',sessionId,turnId));}
    catch(error){
      const snapshot=process.snapshot,code=(error as {code?:unknown}).code;
      return {harnessId:'zcode',nativeConversationId:target.nativeConversationId,nativeTurnId:snapshot.nativeTurnId,status:'unknown',responseText:'',exitConfirmed:snapshot.exitConfirmed,failureCode:safeExecutionDiagnostic({code}).code,diagnostics:safeExecutionDiagnostic({code,elapsedMs:Date.now()-executionStartedAt,...snapshot})};
    }
    lease.releaseAfterExit(receipt.exitConfirmed);
    const sessionId = receipt.result.sessionId;
    if (!receipt.exitConfirmed || !sessionId || sessionId !== target.nativeConversationId) return { harnessId: target.harnessId, nativeConversationId: target.nativeConversationId, nativeTurnId: receipt.result.turnId, status: 'unknown', responseText: '', exitConfirmed: false, failureCode: 'RECEIPT_SESSION_MISMATCH_OR_UNCONFIRMED' };
    if (!receipt.result.turnId) return { harnessId: target.harnessId, nativeConversationId: sessionId, nativeTurnId: null, status: 'failed', responseText: '', exitConfirmed: true, failureCode: 'TURN_NOT_OBSERVED' };
    return { harnessId: target.harnessId, nativeConversationId: sessionId, nativeTurnId: receipt.result.turnId, status: 'completed', responseText: receipt.result.response, exitConfirmed: true };
  };
  const deliveryRuns=new Set<Promise<unknown>>();
  triggerDeliveryPump = (): void => {if(applicationStopping)return;const run=pumpMessageDelivery(rt.store, deliveryServices).catch(() => { /* 泵内已按消息如实结算；此处不重抛 */ });deliveryRuns.add(run);void run.finally(()=>deliveryRuns.delete(run));};
  // 复核批次一：官方会话观察核验（adopt来源）——zcode=app-server resume+read；codex=adapter.resumeThread（真实连接与线程状态观察）
  officialObserve = async (target: DeliveryTarget): Promise<boolean> => {
    try {
      if (target.harnessId === 'codex') {
        if (!options.native?.codex) return false;
        const { detectCodexIdentity } = await import("../execution/codex-supervisor.js");
        const { CodexAdapter } = await import("../adapters/codex-adapter.js");
        const codexEnv = buildCodexEnv(options.native.codex.profileDirectory, options.native.codex.sharedLogin === true);
        const detected = detectCodexIdentity(options.native.codex.executable);
        const identity = { harnessId: 'codex', version: detected.version, executableSha256: detected.executableSha256, bundleSha256: null, adapterProtocol: 'codex-app-server-jsonl-v2', route: 'official_rpc' } as const;
        if(!target.hostId||!target.profileId)return false;
        const adapter = new CodexAdapter({ rpcTimeoutMs: rpcRequestTimeout(options.native.codex.rpcTimeoutMs), executable: options.native.codex.executable, cwd: target.workspaceRoot || codexEnv.cwd, env: codexEnv.env, ...(options.native.codex.timeoutMs !== undefined ? { timeoutMs: options.native.codex.timeoutMs } : {}), leaseDirectory: options.native.codex.leaseDirectory, hostId: target.hostId, profileId: target.profileId, compatibility: { registry, identity } });
        try { await adapter.resumeThread(target.nativeConversationId); return true; } finally { await adapter.close().catch(() => undefined); }
      }
      if (target.harnessId !== 'zcode') return false;
      if (!options.native?.zcode) return false;
      const { observeZcodeSession } = await import("../execution/zcode-supervisor.js");
      const observed = await observeZcodeSession(options.native.zcode.executable, options.native.zcode.bundle, target.workspaceRoot || '.', target.nativeConversationId, options.native.zcode.env);
      return observed !== null;
    } catch { return false; }
  };
  const deliveryServices = { now: (): number => Date.now(), runInBinding, officialObserve, assertSenderAuthorized: (messageId: string): void => assertMessageSenderAuthorized(rt.store,messageId,Date.now(),principalId), assertOwner: (): void => { if (observationDetached||!runtime.isOwner()) throw new Error('KERNEL_OWNER_LOST'); } };
  // 复核批次二：消息泵周期驱动（与workflow轮询同频）——排队消息不依赖人工查询/单次触发推进
  pumpInterval = setInterval(() => { if (runtime.isOwner()){try{
    advanceQuestionWorkflow(rt.store,Date.now(),8);
    pumpRoleProvisioning(rt.store,factory,{now:Date.now,isOwner:()=>runtime.isOwner(),workspaceForRole:workspaceDirectoryFor,onBoundSession:injectToolEntry,principalForBinding:bindingId=>{
      const row=rt.store.db.prepare('SELECT b.epoch,s.harness_id,s.host_id,s.profile_id,s.native_conversation_id,s.native_workspace_id FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.id=? AND b.ended_at IS NULL').get(bindingId);if(!row)throw Error('BINDING_NOT_FOUND');
      const session={harnessId:String(row.harness_id),hostId:String(row.host_id),profileId:String(row.profile_id),nativeConversationId:String(row.native_conversation_id),...(row.native_workspace_id?{nativeWorkspaceId:String(row.native_workspace_id)}:{})};
      return authenticateAgentCredential(rt.store,verifiedBindingCredential(rt.store,path.join(directory,'binding-credentials.json'),bindingId,session,Number(row.epoch),Date.now()),Date.now());
    }});
  }catch{/* 原子失败留原状态与持久操作；不伪造成功。 */}triggerDeliveryPump();} }, options.workflowPollMs ?? 1000);
  pumpInterval.unref?.();
  // T110b：绑定登记后注入会话内工具入口——签发角色凭据并写会话工作区.zcode/mcp.json（指向内核HTTP入口）
  injectToolEntry = (bindingId: string, _roleId: string, harnessId: string, workspaceRoot: string): void => {
    if (harnessId === 'codex') { codexRoleTools(bindingId); return; } // 启动/恢复时用进程级官方 -c 参数加载，不写用户配置。
    if (harnessId !== 'zcode' || !options.native?.zcode) throw new Error('HARNESS_ROLE_TOOLS_UNAVAILABLE');
    const hostUrl = (runtime as unknown as { mcpEntrypoint?: { url: string } }).mcpEntrypoint?.url;
    if (!hostUrl) throw new Error('MCP_ENTRYPOINT_NOT_READY');
    const sess = rt.store.db.prepare("SELECT s.harness_id AS h, s.host_id AS ho, s.profile_id AS p, s.native_conversation_id AS n, s.native_workspace_id AS w, b.epoch AS e FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.id=? AND b.ended_at IS NULL").get(bindingId) as { h: string; ho: string; p: string; n: string; w: string|null; e: number } | undefined;
    if (!sess) throw new Error('BINDING_NOT_FOUND');
    const credential = verifiedBindingCredential(rt.store, path.join(directory, 'binding-credentials.json'), bindingId, { harnessId: sess.h, hostId: sess.ho, profileId: sess.p, nativeConversationId: sess.n, ...(sess.w?{nativeWorkspaceId:sess.w}:{}) }, Number(sess.e), Date.now());
    const project = rt.store.db.prepare('SELECT project_id FROM role_bindings WHERE id=?').get(bindingId) as {project_id:string};
    writeBindingToolConfig(workspaceRoot, project.project_id, bindingId, hostUrl, credential);
  };
  Object.assign(orchestration, {
    projectBootstrap: projectBootstrapOrchestration(rt.store, factory, charterFor, { onBoundSession: injectToolEntry }, workspaceDirectoryFor),
    messageSend: messageSendOrchestration(rt.store, factory, { onQueued: () => triggerDeliveryPump(), onBoundSession: injectToolEntry },workspaceDirectoryFor),
    taskDispatch: taskDispatchOrchestration(rt.store),
  });
  // 供用户显式配置的本地stdio入口发现当前HTTP端点；不含令牌或角色凭据。
  writeFileSync(path.join(directory,'runtime-discovery.json'),JSON.stringify({schemaVersion:2,mcpUrl:runtime.mcpEntrypoint?.url,pid:process.pid,startedAt:Date.now()})+'\n',{mode:0o600});
  let stopPromise: Promise<void> | undefined;
  return Object.freeze({ ...runtime,
    recoverInterruptedMessage:(projectId:string,messageId:string)=>{
      const config=options.native?.codex;if(!config)throw Error('CODEX_RUNTIME_NOT_CONFIGURED');
      return recoverInterruptedCodexMessage(rt.store,projectId,messageId,{executable:config.executable,env:buildCodexEnv(config.profileDirectory,config.sharedLogin===true).env,leaseDirectory:config.leaseDirectory,registry,now:Date.now,assertOwner:()=>{if(applicationStopping||!runtime.isOwner())throw Error('KERNEL_NOT_OWNER');}});
    },
    stop: (): Promise<void> => {
    if (!stopPromise) {
      applicationStopping=true;
      quiesceFactoryOrchestrations(rt.store);
      if (pumpInterval !== undefined) clearInterval(pumpInterval);
      // 已发工厂的官方ID/章程观察必须先落盘；停止期间禁止下一次外发，不能先关库丢掉回执。
      const gatewayClose=runtime.gateway.close(),workflowDrain=runtime.quiesceWorkflow();
      stopPromise=(async()=>{
        let deadline:ReturnType<typeof setTimeout>|undefined;
        try{
          const settled=Promise.allSettled([gatewayClose,workflowDrain,settleRoleProvisioning(rt.store),settleFactoryOrchestrations(rt.store),...deliveryRuns]).then(()=>true);
          const finished=await Promise.race([settled,new Promise<false>(resolve=>{deadline=setTimeout(()=>resolve(false),shutdownDrainMs);})]);
          if(!finished&&runtime.isOwner()){
            detachRoleProvisioning(rt.store,Date.now());
            detachFactoryOrchestrations(rt.store,Date.now());
            rt.store.transaction(()=>interruptNativeWritesWithin(rt.store,Date.now()));
            for(const row of rt.store.db.prepare("SELECT id,project_id FROM messages WHERE state='sending'").all())markUncertainDelivery(rt.store,String(row.project_id),String(row.id),{failureCode:'SHUTDOWN_DRAIN_DEADLINE',exitConfirmed:false},Date.now());
          }
        }finally{if(deadline!==undefined)clearTimeout(deadline);if(runtime.isOwner())rt.store.transaction(()=>interruptNativeWritesWithin(rt.store,Date.now()));sealFactoryOrchestrations(rt.store);sealRoleProvisioning(rt.store);observationDetached=true;runtimeRef=null;await runtime.stop();}
      })();
    }
    return stopPromise;
  } });
  } catch (error) {
    // 内核已启动但应用装配失败：释放本次取得的监听、工作流、锁和数据库。
    // 保留原始装配异常；关闭失败不允许掩盖启动失败原因。
    runtimeRef = null;
    if (pumpInterval !== undefined) clearInterval(pumpInterval);
    try { await runtime.stop(); } catch { /* stop 自身以 finally 释放存储与锁 */ }
    throw error;
  }
}

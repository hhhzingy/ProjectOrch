import {safeExecutionDiagnostic} from '../native/execution-diagnostics.js';
import {executionTimeout, rpcRequestTimeout, type ExecutionTimeoutOptions} from '../native/execution-timeout.js';
/** T111（PR2-W1）：ZCode 持久会话工厂 + 既有协调器装配保留。
 * 工厂（ZcodeSessionFactory）：
 * - 复用既有 ZCodeTextProcess/NativeSessionLease/NativeCompatibilityRegistry（不另写较弱驱动）
 * - 版本探针不硬编码：detectZcodeIdentity 现场读取（R043每次操作重核字节）
 * - 受信环境：继承启动器 provider 配置路径变量 + 每子进程唯一 ZCODE_PROCESS_LABEL（实测：继承标签导致子实例冲突退出）
 * - cwd = 项目工作区（R105归类）
 * - 首条输入 = 角色章程（R107）；随后走既有 completeStartupAck 完成握手才准许开发动作
 * - 进程代次/调度ID/原生turn ID 分离；started/观察用官方结果（不伪造原生ID）
 * - 持久分步操作（F05）：每步先记发送边界（onStep回调由调用方持久化）再观察官方结果；
 *   unknown 如实停在 unknown 不盲重试；不承诺无半创建——承诺不出现静默半状态
 *
 * 下方保留原 T039/T035 协调器装配（ZcodeCliExecutionDriver/buildExecutionServices/createZcodeWorkflowRuntime），
 * 由 WorkflowConsumer 消费（离线闭环已验证）；生产驱动准入仍经 registry 能力核验。 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { Store } from "@projectorch/persistence";
import type { SessionRef } from "@projectorch/adapter-contract";
import { parseSessionRef } from "@projectorch/adapter-contract";
import { NativeCompatibilityRegistry, type NativeIdentity } from "../native/compatibility.js";
import { ZCodeTextProcess, type ZCodeTextProcessOptions, type ZCodeTextProcessReceipt } from "../native/zcode-text-process.js";
import { authenticateAgentCredential, assertAgentPrincipalCurrent } from "../auth/agent-credential.js";
import { ExecutionCoordinator, NativeDispatchNotSent } from "./coordinator.js";
import { WorkflowConsumer } from "./workflow-consumer.js";
import { NativeSessionLease } from "../native/session-lease.js";
import { NativeRpcError } from "../native/stdio-peer.js";
import { taskExecutionPrompt } from './task-prompt.js';
import { inspectZcodeExecution, inspectCodexExecution } from '../native/execution-observation.js';
import { sameSession } from '@projectorch/adapter-contract';
import type { NativeModelSelection } from '../native/model-selection.js';
import { detectCodexIdentity } from "./codex-supervisor.js";

// ==================== T111：持久会话工厂 ====================

export interface ZcodeSessionFactoryOptions extends ExecutionTimeoutOptions {
  readonly executable: string;
  readonly bundle: string;
  /** 受信启动器白名单环境（含启动器provider配置路径变量）。 */
  readonly env: Readonly<Record<string, string>>;
  readonly leaseDirectory: string;
  readonly registry: NativeCompatibilityRegistry;
  readonly timeoutMs?: number;
}

/** R043：版本探针——现场读取 zcode --version + 双端字节哈希（不硬编码）。 */
export function detectZcodeIdentity(executable: string, bundle: string): { readonly version: string; readonly executableSha256: string; readonly bundleSha256: string } {
  const out = execFileSync(executable, [bundle, "--version"], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  const version = out.trim();
  if (!version) throw new Error("ZCODE_VERSION_FAILED");
  const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
  return { version, executableSha256: sha(executable), bundleSha256: sha(bundle) };
}

export interface FactoryOperationStep {
  readonly step: "create-session" | "deliver-charter" | "startup-ack" | "observe-effective-model";
  readonly state: "pending" | "sent" | "observed" | "unknown" | "failed";
  readonly detail: string | null;
  readonly at: number;
}

export interface FactoryOutcome {
  readonly receipt: ZCodeTextProcessReceipt;
  readonly sessionRef: SessionRef;
  readonly processEpoch: string;
  readonly nativeSessionId: string;
  readonly nativeTurnId: string | null;
  /** 权威生效模型（app-server resume读回；读回失败为null不阻断）。 */
  readonly effectiveModel: { modelId: string; providerId: string | null } | null;
}

/** 权威会话模型观察（导出——泵的官方核验与effective读回共用）：app-server resume+read（只读不占lease）。 */
export async function observeZcodeSession(executable: string, bundle: string, cwd: string, sessionId: string, baseEnv: Readonly<Record<string, string>>): Promise<import('../native/session-model-observation.js').ZcodeSessionModelObservation | null> {
  const { StdioPeer } = await import("../native/stdio-peer.js");
  const env: Record<string, string> = { ...baseEnv, NO_COLOR: "1" };
  const peer = new StdioPeer({ executable, args: [bundle, "app-server"], cwd, env, timeoutMs: 30000, onNotification() {} });
  try {
    await peer.ready;
    await new Promise(resolve => setTimeout(resolve, 5000));
    const resumed = await peer.request("session/resume", { sessionId, workspace:{workspacePath:cwd,workspaceKey:cwd} });
    const read = await peer.request("session/read", { sessionId, contentProfile: "index" });
    const {zcodeSessionModelObservation}=await import('../native/session-model-observation.js');
    return zcodeSessionModelObservation(resumed,read,sessionId);
  } finally { await peer.close().catch(() => undefined); }
}

export async function observeSessionModel(executable:string,bundle:string,cwd:string,sessionId:string,baseEnv:Readonly<Record<string,string>>):Promise<{modelId:string;providerId:string|null}|null>{
 return (await observeZcodeSession(executable,bundle,cwd,sessionId,baseEnv))?.model??null;
}

export class ZcodeSessionFactory {
  readonly #options: ZcodeSessionFactoryOptions;

  constructor(options: ZcodeSessionFactoryOptions) {
    if (!options.executable || !options.bundle || !options.env || !options.leaseDirectory) throw new Error("INVALID_FACTORY_OPTIONS");
    if (!(options.registry instanceof NativeCompatibilityRegistry)) throw new Error("TRUSTED_REGISTRY_REQUIRED");
    this.#options = {...options, timeoutMs: executionTimeout(options)};
  }

  /** 当前身份（每次工厂操作重核——R043）。 */
  identity(): NativeIdentity {
    const detected = detectZcodeIdentity(this.#options.executable, this.#options.bundle);
    return Object.freeze({ harnessId: "zcode", version: detected.version, executableSha256: detected.executableSha256, bundleSha256: detected.bundleSha256, adapterProtocol: "zcode-cli-jsonl-v2", route: "official_cli" });
  }

  /** 能力核验：工厂路径最低能力（roleTools 走 T110 MCP 入口，不在本工厂范围）。 */
  assertCapabilities(): void {
    const identity = this.identity();
    for (const capability of ["textInput", "resume", "historyRead"] as const) {
      if (!this.#options.registry.decide(identity, capability).enabled) throw new NativeRpcError(`NATIVE_CAPABILITY_UNVERIFIED:${capability}`,"not_sent");
    }
  }

  /**
   * 创建持久会话并下发章程。持久分步：调用方经 onStep 在每步边界持久化（先 sent 后 observed/unknown）。
   * CLI 一次性调用（--prompt=章程）同时完成官方持久会话创建与章程首输入；sessionId/turnId 均为官方观察值。
   */
  async createSessionWithCharter(input: {
    readonly assertCanSend?:()=>void;
    readonly charter: string;
    readonly workspaceRoot: string;
    readonly hostId: string;
    readonly profileId: string;
    readonly onStep: (step: FactoryOperationStep) => void;
  }): Promise<FactoryOutcome> {
    this.assertCapabilities();
    // 缺目录是确定未发送，不能在CLI已创建会话后才发现本地前置不满足。
    try { NativeSessionLease.assertDirectory(this.#options.leaseDirectory); }
    catch { throw new NativeRpcError("FACTORY_LEASE_DIRECTORY_UNAVAILABLE", "not_sent"); }
    const processEpoch = randomUUID();
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.#options.env)) env[key] = value;
    env.ZCODE_PROCESS_LABEL = `projectorch-factory-${processEpoch.slice(0, 8)}`;
    env.NO_COLOR = "1";
    const options: ZCodeTextProcessOptions = { executable: this.#options.executable, bundle: this.#options.bundle, cwd: input.workspaceRoot, env, ...(this.#options.timeoutMs !== undefined ? { timeoutMs: this.#options.timeoutMs } : {}) };
    let lease: NativeSessionLease | undefined;
    try {
      input.onStep({ step: "create-session", state: "sent", detail: null, at: Date.now() });
      const process = new ZCodeTextProcess(options);
      input.assertCanSend?.();
      const receipt = await process.execute(input.charter, null);
      const nativeSessionId = receipt.result.sessionId;
      if (!nativeSessionId) throw new Error("FACTORY_SESSION_NOT_OBSERVED");
      const sessionRef: SessionRef = { harnessId: "zcode", hostId: input.hostId, profileId: input.profileId, nativeConversationId: nativeSessionId, nativeWorkspaceId:input.workspaceRoot };
      lease = NativeSessionLease.acquire(this.#options.leaseDirectory, sessionRef);
      input.onStep({ step: "create-session", state: "observed", detail: nativeSessionId, at: Date.now() });
      input.onStep({ step: "deliver-charter", state: "observed", detail: receipt.result.turnId, at: Date.now() });
      // 执行侧生效模型权威读回（app-server resume+read 的会话元数据——模型自报不可作判据）；失败不阻断建会话，effective留空
      let effectiveModel: { modelId: string; providerId: string | null } | null = null;
      try {
        effectiveModel = await observeSessionModel(this.#options.executable, this.#options.bundle, input.workspaceRoot, nativeSessionId, this.#options.env);
        if (effectiveModel) input.onStep({ step: "observe-effective-model", state: "observed", detail: `${effectiveModel.providerId ?? "?"}/${effectiveModel.modelId}`, at: Date.now() });
      } catch { /* 读回尽力：不可用时由后续监督补 */ }
      lease.releaseAfterExit(receipt.exitConfirmed); lease=undefined;
      return { receipt, sessionRef, processEpoch, nativeSessionId, nativeTurnId: receipt.result.turnId, effectiveModel };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 复核批次一：脱敏stderr摘要透出到步骤（排障可见，不含敏感原文）
      const stderrSummary = (error as { nativeStderrSummary?: string | null }).nativeStderrSummary ?? null;
      const state = /UNCONFIRMED|TIMEOUT|UNKNOWN/u.test(message) ? "unknown" : "failed";
      input.onStep({ step: "create-session", state, detail: `${message.slice(0, 160)}${stderrSummary ? ` | stderr:${stderrSummary}` : ""}`, at: Date.now() });
      try { lease?.releaseAfterExit(true); } catch { /* 尽力清理 */ }
      throw error;
    }
  }
}

// ==================== 既有 T039/T035 协调器装配（保留） ====================

export interface ZcodeSupervisorConfig extends ExecutionTimeoutOptions {
  readonly trustedLocalUserId?:string;
  readonly executable?: string;
  readonly bundle?: string;
  /** 必须由受信启动器提供环境白名单（含启动器注入的provider配置路径），不能全盘继承宿主。 */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly workspaceForTask: (projectId: string, taskId: string, bindingId: string) => string;
  readonly leaseDirectory?: string;
  readonly maxPerPump?: number;
  readonly beforeTurn?: (session:SessionRef,assertCurrent:()=>void,input?:unknown)=>Promise<void>;
}

/** ZCode CLI纯文本路由的ManagedExecutionDriver（离线闭环已验证；生产准入经registry能力核验）。 */
export class ZcodeCliExecutionDriver {
  readonly supportsReadOnlyRecovery=true as const;
  readonly session: SessionRef;
  readonly ownerKey: string;
  readonly workspaceRoot: string;
  readonly registry: NativeCompatibilityRegistry;
  readonly #process: ZCodeTextProcess;
  readonly #identity: NativeIdentity;
  #closed = false;
  #lease: NativeSessionLease | null = null;
  readonly #leaseDirectory: string | undefined;
  readonly #observationConfig: ZCodeTextProcessOptions;
  readonly #beforeTurn: ((session:SessionRef,assertCurrent:()=>void,input?:unknown)=>Promise<void>)|undefined;

  constructor(session: SessionRef, workspaceRoot: string, registry: NativeCompatibilityRegistry, processOptions: ZCodeTextProcessOptions & { readonly leaseDirectory?: string;readonly beforeTurn?:(session:SessionRef,assertCurrent:()=>void,input?:unknown)=>Promise<void> }) {
    this.session = parseSessionRef(session);
    this.workspaceRoot = workspaceRoot;
    this.registry = registry;
    executionTimeout(processOptions);
    const detected = detectZcodeIdentity(processOptions.executable, processOptions.bundle);
    this.#identity = Object.freeze({ harnessId: "zcode", version: detected.version, executableSha256: detected.executableSha256, bundleSha256: detected.bundleSha256, adapterProtocol: "zcode-cli-jsonl-v2", route: "official_cli" });
    this.ownerKey = `zcode-cli:${randomUUID().slice(0, 12)}`;
    this.#process = new ZCodeTextProcess(processOptions);
    this.#observationConfig=processOptions;
    this.#beforeTurn=processOptions.beforeTurn;
    this.#leaseDirectory = processOptions.leaseDirectory;
  }

  identity(): NativeIdentity { return this.#identity; }
  assertOwner(): void { if (this.#closed) throw new Error("DRIVER_CLOSED"); this.#lease?.assertCurrent(this.session); }
  assertIsolation(policy: { readonly writeIsolation: string }): void { if(policy.writeIsolation==='enforced_paths') throw new Error('PATH_ENFORCEMENT_UNAVAILABLE'); }

  start(input: unknown, started: (session: SessionRef, executionId: string) => void, assertCanSend: () => void = () => {}): { result: Promise<{ session: SessionRef; executionId: string; status: "completed" | "failed" | "interrupted" | "unknown"; terminalConfirmed: boolean; responseExcerpt?: string }> } {
    if (this.#closed) throw new Error("DRIVER_CLOSED");
    assertCanSend();
    let prompt: string;
    try { prompt=taskExecutionPrompt(input); } catch { throw new NativeDispatchNotSent('INVALID_TASK_EXECUTION_INPUT'); }
    if (!this.#leaseDirectory) throw new NativeDispatchNotSent('NATIVE_LEASE_DIRECTORY_REQUIRED');
    if (this.#lease) throw new NativeDispatchNotSent('NATIVE_OWNER_NOT_IDLE');
    try { this.#lease = NativeSessionLease.acquire(this.#leaseDirectory,this.session); }
    catch { throw new NativeDispatchNotSent('NATIVE_OWNER_OCCUPIED'); }
    let executionId = ''; // 未观察到原生turn前不填调度UUID冒充原生身份。
    let sent=false;const startedAt=Date.now();
    const run=async()=>{await Promise.resolve();await this.#beforeTurn?.(this.session,assertCanSend,input);assertCanSend();sent=true;return this.#process.execute(prompt, this.session.nativeConversationId, undefined, (_sessionId, turnId) => { executionId = turnId; started(this.session, turnId); });};
    const result = run().then((receipt: ZCodeTextProcessReceipt): { session: SessionRef; executionId: string; status: "completed" | "failed" | "interrupted" | "unknown"; terminalConfirmed: boolean; responseExcerpt?: string } => {
      if (!receipt.exitConfirmed || !receipt.result.sessionId || receipt.result.sessionId !== this.session.nativeConversationId) {
        return { session: this.session, executionId, status: "unknown", terminalConfirmed: false };
      }
      this.#lease!.releaseAfterExit(true); this.#lease=null;
      return { session: this.session, executionId, status: receipt.result.turnId ? "completed" : "unknown", terminalConfirmed: receipt.result.turnId !== null, responseExcerpt: String(receipt.result.response ?? "").slice(0, 600) };
    }).catch(error => {if(!sent){this.#lease?.releaseAfterExit(true);this.#lease=null;throw new NativeDispatchNotSent(error instanceof NativeRpcError?'MODEL_SELECTION_UNAVAILABLE':'EXECUTION_ADMISSION_CHANGED');}return { session: this.session, executionId, status: "unknown" as const, terminalConfirmed: false, diagnostics:safeExecutionDiagnostic({code:error?.code,elapsedMs:Date.now()-startedAt,...this.#process.snapshot}) };});
    return { result };
  }
  inspectExecution(input:{session:SessionRef;executionId:string}){
    this.assertOwner();
    if(!sameSession(input.session,this.session))throw new Error('OBSERVATION_SESSION_MISMATCH');
    const result=inspectZcodeExecution(this.#observationConfig,this.session,input.executionId);
    return {result};
  }
  confirmRecoveredTerminal(outcome:import('./coordinator.js').NativeExecutionOutcome):void{
    if(!sameSession(outcome.session,this.session)||!outcome.terminalConfirmed)throw new Error('LEASE_TERMINAL_PROOF_REQUIRED');
    if(this.#lease){
      if(!this.#process.snapshot.exitConfirmed)throw new Error('LEASE_PROCESS_EXIT_UNCONFIRMED');
      this.#lease.releaseAfterExit(true);this.#lease=null;
    }else{
      if(!this.#leaseDirectory)throw new Error('NATIVE_LEASE_DIRECTORY_REQUIRED');
      NativeSessionLease.recoverAfterTerminal(this.#leaseDirectory,this.session,outcome);
    }
  }
  close(): void { this.#closed = true; } // 未知在途占位保留，不能用关闭动作伪装已退出。
}

export interface SupervisorServices {
  readonly now: () => number;
  readonly isKernelOwner: () => boolean;
  readonly sessionForBinding: (bindingId: string) => { readonly session: SessionRef; readonly workspaceRoot: string; readonly credential: string };
}

/** 复核批次一：Codex官方app-server执行驱动（与ZcodeCliExecutionDriver同接口——协调器harness无关）。
 * start=resume绑定线程+真实轮；回执状态映射completed/failed/unknown，不伪造；close释放adapter连接。 */
export interface CodexDriverConfig extends ExecutionTimeoutOptions { readonly rpcTimeoutMs?:number; readonly executable: string; readonly env: Readonly<Record<string, string>>; readonly cwd: string; readonly leaseDirectory: string; readonly timeoutMs?: number; readonly configOverrides?: readonly string[]; readonly modelSelection?:()=>NativeModelSelection|null; readonly prepareTurn?:(input:unknown)=>{readonly env:Readonly<Record<string,string>>;readonly configOverrides:readonly string[]}; }

export class CodexCliExecutionDriver {
  readonly supportsReadOnlyRecovery=true as const;
  readonly session: SessionRef;
  readonly ownerKey: string;
  readonly workspaceRoot: string;
  readonly registry: NativeCompatibilityRegistry;
  #closed = false;
  readonly #config: CodexDriverConfig;
  #adapterPromise: Promise<import("../adapters/codex-adapter.js").CodexAdapter> | null = null;
  #lastNativeTurn: string | null = null;
  #ownedRecovery: {executionId:string;status:string} | null = null;
  #turnTools:{readonly env:Readonly<Record<string,string>>;readonly configOverrides:readonly string[]}|null=null;
  constructor(session: SessionRef, workspaceRoot: string, registry: NativeCompatibilityRegistry, config: CodexDriverConfig) {
    this.session = parseSessionRef(session);
    if (this.session.harnessId !== "codex") throw new Error("CODEX_DRIVER_SESSION_MISMATCH");
    this.workspaceRoot = workspaceRoot;
    this.registry = registry;
    rpcRequestTimeout(config.rpcTimeoutMs);
    this.#config = {...config, timeoutMs: executionTimeout(config)};
    this.ownerKey = `codex-app:${randomUUID().slice(0, 12)}`;
  }
  identity(): NativeIdentity {
    const detected = detectCodexIdentity(this.#config.executable);
    return Object.freeze({ harnessId: "codex", version: detected.version, executableSha256: detected.executableSha256, bundleSha256: null, adapterProtocol: "codex-app-server-jsonl-v2", route: "official_rpc" });
  }
  assertOwner(): void { if (this.#closed) throw new Error("DRIVER_CLOSED"); }
  assertIsolation(policy: { readonly writeIsolation: string }): void { if(policy.writeIsolation==='enforced_paths') throw new Error('PATH_ENFORCEMENT_UNAVAILABLE'); }
  async #adapter(): Promise<import("../adapters/codex-adapter.js").CodexAdapter> {
    if (this.#adapterPromise) return this.#adapterPromise;
    this.#adapterPromise = (async () => {
      const { CodexAdapter } = await import("../adapters/codex-adapter.js");
      const adapter = new CodexAdapter({ executable: this.#config.executable, cwd: this.#config.cwd, env: this.#turnTools?.env??this.#config.env, ...((this.#turnTools?.configOverrides??this.#config.configOverrides) ? { configOverrides: this.#turnTools?.configOverrides??this.#config.configOverrides } : {}), ...(this.#config.timeoutMs !== undefined ? { timeoutMs: this.#config.timeoutMs } : {}), leaseDirectory: this.#config.leaseDirectory, hostId: this.session.hostId, profileId: this.session.profileId, compatibility: { registry: this.registry, identity: this.identity() }, ...(this.#config.rpcTimeoutMs !== undefined ? {rpcTimeoutMs:this.#config.rpcTimeoutMs} : {}) });
      await adapter.resumeThread(this.session.nativeConversationId);
      return adapter;
    })();
    return this.#adapterPromise;
  }
  start(input: unknown, started: (session: SessionRef, executionId: string) => void, assertCanSend: () => void = () => {}): { result: Promise<{ session: SessionRef; executionId: string; status: "completed" | "failed" | "interrupted" | "unknown"; terminalConfirmed: boolean; responseExcerpt?: string }> } {
    if (this.#closed) throw new Error("DRIVER_CLOSED");
    let prompt: string;
    try { prompt=taskExecutionPrompt(input); } catch { throw new NativeDispatchNotSent('INVALID_TASK_EXECUTION_INPUT'); }
    let executionId = '';
    let enteredRunTurn=false;
    const dispatchMarker = randomUUID().slice(0,8);
    const result = Promise.resolve().then(async () => {
      // 可确定的模型解析先于取得原生owner，拒绝时不遗留闲置传输/租约。
      const selection=this.#config.modelSelection?.()??undefined;
      if(this.#config.prepareTurn){
        // 只在上一原生轮已可信结束后更换自己持有的传输，保留同一原生线程。
        if(this.#adapterPromise)throw new NativeDispatchNotSent('NATIVE_OWNER_NOT_IDLE');
        assertCanSend();this.#turnTools=this.#config.prepareTurn(input);
      }
      const adapter=await this.#adapter();
      assertCanSend();
      const marker = `DONE_${dispatchMarker}`;
      enteredRunTurn=true;
      const turn = await adapter.runTurn(`${prompt}\n\n完成后只回复：${marker}`, marker, executionTimeout(this.#config), turnId => { executionId=turnId;this.#lastNativeTurn=turnId; started(this.session,turnId); },assertCanSend,selection);
      // 原生终态足以安全关闭本轮空闲传输；业务完成标记缺失仍保留unknown，交给只读恢复核实。
      if(this.#config.prepareTurn&&['completed','failed','interrupted'].includes(turn.status)){await adapter.close();this.#adapterPromise=null;this.#turnTools=null;}
      if (turn.status === "completed" && turn.markerSeen) return { session: this.session, executionId, status: "completed" as const, terminalConfirmed: true, responseExcerpt: turn.text.slice(0, 600) };
      if (turn.status === "failed") return { session: this.session, executionId, status: "failed" as const, terminalConfirmed: true, ...(turn.diagnostics?{diagnostics:safeExecutionDiagnostic(turn.diagnostics)}:{}) };
      if (turn.status === "interrupted") return { session: this.session, executionId, status: "interrupted" as const, terminalConfirmed: true };
      return { session: this.session, executionId, status: "unknown" as const, terminalConfirmed: false, ...(turn.diagnostics?{diagnostics:turn.diagnostics}:{}) };
    }).catch(error => {if(error instanceof NativeDispatchNotSent)throw error;if(!enteredRunTurn&&error instanceof NativeRpcError&&error.delivery==='not_sent')throw new NativeDispatchNotSent('MODEL_SELECTION_UNAVAILABLE');return { session: this.session, executionId, status: "unknown" as const, terminalConfirmed: false };});
    return { result };
  }
  async close(): Promise<void> { this.#closed = true; try { const a = await this.#adapterPromise; await a?.close(); } catch { /* 尽力 */ } }
  inspectExecution(input:{session:SessionRef;executionId:string}){
    this.assertOwner();
    if(!sameSession(input.session,this.session))throw new Error('OBSERVATION_SESSION_MISMATCH');
    const result=(async()=>{
      if(this.#adapterPromise){
        if(input.executionId!==this.#lastNativeTurn)throw new Error('EXECUTION_ID_MISMATCH');
        const adapter=await this.#adapterPromise;
        const status=await adapter.recoverOwnedTerminal(input.executionId);
        this.#ownedRecovery={executionId:input.executionId,status};this.#adapterPromise=null;
        return {session:this.session,executionId:input.executionId,status,terminalConfirmed:true};
      }
      return inspectCodexExecution(this.#config,this.session,input.executionId);
    })();
    return {result};
  }
  confirmRecoveredTerminal(outcome:import('./coordinator.js').NativeExecutionOutcome):void{
    if(!sameSession(outcome.session,this.session)||!outcome.terminalConfirmed)throw new Error('LEASE_TERMINAL_PROOF_REQUIRED');
    if(this.#ownedRecovery){
      if(outcome.executionId!==this.#ownedRecovery.executionId||outcome.status!==this.#ownedRecovery.status)throw new Error('LEASE_TERMINAL_PROOF_REQUIRED');
      this.#ownedRecovery=null;return;
    }
    NativeSessionLease.recoverAfterTerminal(this.#config.leaseDirectory,this.session,outcome);
  }
}

/** 构建ExecutionServices：绑定→主体→驱动→门槛（实时核验）。 */
export function buildExecutionServices(store: Store, supervisorServices: SupervisorServices, registry: NativeCompatibilityRegistry, processOptionsFor: (session: SessionRef, workspaceRoot: string) => ZCodeTextProcessOptions & {beforeTurn?:(session:SessionRef,assertCurrent:()=>void,input?:unknown)=>Promise<void>}, codexConfigFor?: (session: SessionRef, workspaceRoot: string) => CodexDriverConfig) {
  // 复核批次一：驱动按绑定会话harness路由——zcode=CLI resume；codex=官方app-server线程轮（此前codex绑定在GATE_HARNESS_MISMATCH被拒）
  const drivers = new Map<string, ZcodeCliExecutionDriver | CodexCliExecutionDriver>();
  const services = {
    now: supervisorServices.now,
    isKernelOwner: supervisorServices.isKernelOwner,
    assertGates(session: SessionRef) {
      const parsed = parseSessionRef(session);
      if (parsed.harnessId !== "zcode" && parsed.harnessId !== "codex") throw new Error("GATE_HARNESS_MISMATCH");
      if (parsed.harnessId === "codex" && !codexConfigFor) throw new Error("CODEX_RUNTIME_NOT_CONFIGURED");
    },
    principalForBinding(bindingId: string) {
      const { credential } = supervisorServices.sessionForBinding(bindingId);
      const principal = authenticateAgentCredential(store, credential, supervisorServices.now());
      assertAgentPrincipalCurrent(store, principal, supervisorServices.now());
      return principal;
    },
    driverForBinding(bindingId: string) {
      let driver = drivers.get(bindingId);
      if (driver) return driver;
      const { session, workspaceRoot } = supervisorServices.sessionForBinding(bindingId);
      const parsed = parseSessionRef(session);
      if (parsed.harnessId === "codex") {
        if (!codexConfigFor) throw new Error("CODEX_RUNTIME_NOT_CONFIGURED");
        driver = new CodexCliExecutionDriver(session, workspaceRoot, registry, codexConfigFor(session, workspaceRoot));
      } else {
        driver = new ZcodeCliExecutionDriver(session, workspaceRoot, registry, { ...processOptionsFor(session, workspaceRoot), cwd: workspaceRoot });
      }
      drivers.set(bindingId, driver);
      return driver;
    },
  };
  return { services, ExecutionCoordinator };
}

/** 组装WorkflowRuntime（离线闭环已验证——workflow-factory.test.mjs）。 */
export function createZcodeWorkflowRuntime(store: Store, context: { readonly now: () => number; readonly isKernelOwner: () => boolean }, config: ZcodeSupervisorConfig, sessionForBinding: SupervisorServices["sessionForBinding"], registry: NativeCompatibilityRegistry, codexConfigFor?: (session: SessionRef, workspaceRoot: string) => CodexDriverConfig) {
  const processOptionsFor = (_session: SessionRef, workspaceRoot: string): ZCodeTextProcessOptions & {beforeTurn?:(session:SessionRef,assertCurrent:()=>void,input?:unknown)=>Promise<void>} => {
    if(!config.executable||!config.bundle||!config.env)throw new Error('ZCODE_RUNTIME_NOT_CONFIGURED');
    return { executable: config.executable, bundle: config.bundle, cwd: workspaceRoot, env: config.env,...(config.beforeTurn?{beforeTurn:config.beforeTurn}:{}), ...(config.leaseDirectory ? {leaseDirectory:config.leaseDirectory} : {}), timeoutMs:executionTimeout(config) };
  };
  const { services, ExecutionCoordinator } = buildExecutionServices(store, { now: context.now, isKernelOwner: context.isKernelOwner, sessionForBinding }, registry, processOptionsFor, codexConfigFor);
  const coordinator = new ExecutionCoordinator(store, services);
  return new WorkflowConsumer(store, coordinator, { workspaceForTask: config.workspaceForTask, ...(config.trustedLocalUserId?{trustedLocalUserId:config.trustedLocalUserId}:{}), ...(config.maxPerPump !== undefined ? { maxPerPump: config.maxPerPump } : {}) });
}


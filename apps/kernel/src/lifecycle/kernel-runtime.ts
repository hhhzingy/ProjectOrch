/** T019准备切片：内核生命周期协调。启动序列=打开存储→单实例锁→启动本地网关→启动Outbox投递循环→就绪；
 * 优雅停止=拒绝新工作→停投递→停HTTP→释放单实例锁→关存储；重启恢复=过期租约回收+事件水位读取。默认不含原生派发。 */
import { randomUUID } from "node:crypto";
import type { Store } from "@projectorch/persistence";
import { openStore } from "@projectorch/persistence";
import { recoverExpiredOutbox } from "@projectorch/persistence/outbox";
import { startLocalGateway, type StartedGateway } from "../http/local-gateway.js";
import { pumpOutbox, type OutboxWorkerOptions } from "../commands/outbox-worker.js";
import { startMcpHttpHost, type McpHttpHost, type McpBackend } from "../tools/mcp-http-host.js";
import type { WorkflowRuntime } from "../execution/workflow-consumer.js";

export interface KernelOptions {
  readonly readConversation?:import('../http/local-gateway.js').LocalGatewayOptions['readConversation'];
  readonly filename: string;
  readonly principalId: string;
  readonly now?: () => number;
  /** 单实例锁租约时长（毫秒）；持有进程按租约1/3周期续心跳，进程死亡后租约过期才允许接管。 */
  readonly lockLeaseMs?: number;
  /** 网关命令执行入口与错误映射（T017已实现）；未注入则命令路由返回未启用。 */
  readonly commandRunner?: (principalId: string, input: unknown) => unknown;
  /** 标准应用入口在内核同一Store上装配命令，避免再开一个隐含生命周期的连接。 */
  readonly commandRunnerFactory?: (store: Store) => (principalId: string, input: unknown) => unknown;
  readonly commandErrorStatus?: (message: string) => 400 | 401 | 403 | 409;
  readonly outbox?: { readonly deliver: (lease: import("@projectorch/persistence/outbox").OutboxLease) => import("../commands/outbox-worker.js").OutboxDelivery } & Partial<Pick<OutboxWorkerOptions, "leaseMs" | "backoffMs" | "maxAttempts" | "maxPerPump">>;
  readonly outboxPollMs?: number;
  /** 仅受信启动器装配官方驱动/工具宿主；默认未配置，不从HTTP/模型接受工厂。 */
  readonly workflowFactory?: (store: Store, context: { readonly now: () => number; readonly isKernelOwner: () => boolean }) => WorkflowRuntime;
  readonly workflowPollMs?: number;
  /** 关闭本地观察的等待上限；超时保留已同步保存的unknown，不取消原生工作。 */
  readonly stopDrainMs?:number;
  /** T043：静态控制台产物目录（透传网关静态服务）。 */
  readonly webDistDir?: string;
  /** T110（PR2-W1）：MCP常驻入口。backendForConnection由受信启动器提供（区分控制入口主体/受管角色主体）；
   * 配对令牌由启动器生成保存（initialToken）；审计回调只收白名单元数据。 */
  readonly mcpEntrypoint?: { readonly backendForConnection: (connectionId: string) => McpBackend; readonly initialToken?: string; readonly resolveBearer?: (token: string) => McpBackend | null; readonly onConnectionClose?: (connectionId: string) => void; readonly audit?: (info: { readonly method: string; readonly path: string; readonly status: number; readonly connectionCount: number; readonly reason: string }) => void; readonly connectionLifetimeMs?: number };
}

export interface KernelRuntime {
  readonly gateway: StartedGateway;
  readonly store: Store;
  /** T110：MCP常驻入口（配置mcpEntrypoint时存在；url/bearerToken供受信启动器写入两Harness官方配置）。 */
  readonly mcpEntrypoint?: { readonly url: string; readonly bearerToken: string };
  /** 每次查询核对实际锁与租约；失效后不可由旧实例重新获得权限。 */
  isOwner(): boolean;
  workflowStatus(): { readonly enabled: boolean; readonly healthy: boolean; readonly lastError: string | null; readonly recoveredDispatches: number };
  /** 各项目当前事件水位（重启恢复与SSE续订依据）。 */
  eventWatermarks(): { readonly projectId: string; readonly lastSequence: number }[];
  outboxTotals(): { readonly pending: number; readonly dispatching: number; readonly delivered: number; readonly uncertain: number; readonly exhausted: number };
  /** 受信应用退出阶段：先停预约并保存未知边界，保留数据库/owner供已发工厂记录观察。 */
  quiesceWorkflow(): Promise<void>;
  stop(): Promise<void>;
}

export interface StartResult extends KernelRuntime {
  readonly recovery: { readonly recoveredExpiredLeases: number; readonly watermarks: { readonly projectId: string; readonly lastSequence: number }[] };
}

/** 启动内核：顺序失败即整体失败（存储打开失败不取锁；取锁失败不启动网关；网关失败不启动投递循环）。 */
export async function startKernel(options: KernelOptions): Promise<StartResult> {
  if (options.commandRunner && options.commandRunnerFactory) throw new Error("AMBIGUOUS_COMMAND_RUNNER");
  if (options.workflowFactory !== undefined && (typeof options.workflowFactory !== "function" || options.workflowFactory.constructor.name === "AsyncFunction")) throw new Error("SYNC_WORKFLOW_FACTORY_REQUIRED");
  const workflowPollMs = options.workflowPollMs ?? 1000;
  const stopDrainMs=options.stopDrainMs??30000;if(!Number.isSafeInteger(stopDrainMs)||stopDrainMs<1||stopDrainMs>300000)throw Error('INVALID_STOP_DRAIN_TIMEOUT');
  if (!Number.isSafeInteger(workflowPollMs) || workflowPollMs < 10 || workflowPollMs > 300000) throw new Error("INVALID_WORKFLOW_POLL_INTERVAL");
  const now = options.now ?? Date.now;
  const lockLeaseMs = options.lockLeaseMs ?? 30_000;
  if (!Number.isSafeInteger(lockLeaseMs) || lockLeaseMs < 1_000 || lockLeaseMs > 300_000) throw new Error("INVALID_LOCK_LEASE");
  const store = openStore(options.filename);
  const holder = `${process.pid}:${randomUUID()}`;
  const acquireLock = (): boolean => store.transaction(db => {
    const row = db.prepare("SELECT holder,heartbeat FROM kernel_lock WHERE id=1").get() as { holder: string; heartbeat: number } | undefined;
    if (row && String(row.holder).length > 0 && String(row.holder) !== holder && Number(row.heartbeat) > now() - lockLeaseMs) return false;
    db.prepare("UPDATE kernel_lock SET holder=?,heartbeat=? WHERE id=1").run(holder, now());
    return true;
  });
  let gateway: StartedGateway | undefined;
  let outboxTimer: ReturnType<typeof setInterval> | undefined;
  let mcpHost: McpHttpHost | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let stopping = false;
  let ownershipLost = false;
  let stopPromise: Promise<void> | undefined;
  let workflowDrain:Promise<void>|undefined;
  let recoveryExpired = 0;
  let workflow: WorkflowRuntime | undefined;
  let workflowTimer: ReturnType<typeof setInterval> | undefined;
  let workflowError: string | null = null;
  let recoveredDispatches = 0;
  const assertOwner = (): void => {
    if (stopping) throw new Error("KERNEL_STOPPING");
    if (ownershipLost) throw new Error("KERNEL_OWNER_LOST");
    try {
      const row = store.db.prepare("SELECT holder,heartbeat FROM kernel_lock WHERE id=1").get();
      const time = now();
      if (!Number.isSafeInteger(time) || time < 0 || !row || row.holder !== holder || Number(row.heartbeat) <= time - lockLeaseMs || Number(row.heartbeat) > time) throw new Error("KERNEL_OWNER_LOST");
    } catch { ownershipLost = true; throw new Error("KERNEL_OWNER_LOST"); }
  };
  const isOwner = (): boolean => { try { assertOwner(); return true; } catch { return false; } };
  const releaseLock = (): void => {
    // 仅用于锁自身的条件释放，不绕过业务事务guard写业务数据。
    store.db.prepare("UPDATE kernel_lock SET holder='',heartbeat=0 WHERE id=1 AND holder=?").run(holder);
  };
  if (!acquireLock()) {
    store.close();
    throw new Error("KERNEL_ALREADY_RUNNING");
  }
  try {
    store.installTransactionGuard(() => assertOwner());
    recoveryExpired = recoverExpiredOutbox(store, now());
    workflow = options.workflowFactory?.(store, { now, isKernelOwner: isOwner });
    if (workflow && typeof (workflow as unknown as { then?: unknown }).then === "function") { void Promise.resolve(workflow).catch(() => undefined); throw new Error("INVALID_WORKFLOW_RUNTIME"); }
    if (workflow) {
      if (typeof workflow.recover !== "function" || workflow.recover.constructor.name === "AsyncFunction" || typeof workflow.pump !== "function" || workflow.pump.constructor.name === "AsyncFunction" || typeof workflow.stop !== "function") throw new Error("INVALID_WORKFLOW_RUNTIME");
      const recovered: unknown = workflow.recover();
      if (recovered && typeof (recovered as { then?: unknown }).then === "function") void Promise.resolve(recovered).catch(() => undefined);
      if (!Number.isSafeInteger(recovered) || Number(recovered) < 0) throw new Error("INVALID_WORKFLOW_RECOVERY");
      recoveredDispatches = Number(recovered);
    } else if (options.workflowFactory) throw new Error("INVALID_WORKFLOW_RUNTIME");
    const commandRunner = options.commandRunner ?? options.commandRunnerFactory?.(store);
    gateway = await startLocalGateway({ store, principalId: options.principalId, now, assertKernelOwner: assertOwner, ...(options.readConversation?{readConversation:options.readConversation}:{}), ...(commandRunner !== undefined ? { commandRunner: (principalId, input) => { assertOwner(); return commandRunner(principalId, input); } } : {}), ...(options.commandErrorStatus !== undefined ? { commandErrorStatus: options.commandErrorStatus } : {}), ...(options.webDistDir !== undefined ? { webDistDir: options.webDistDir } : {}) });
    if (options.mcpEntrypoint) mcpHost = await startMcpHttpHost({ backendForConnection: options.mcpEntrypoint.backendForConnection, ...(options.mcpEntrypoint.initialToken !== undefined ? { initialToken: options.mcpEntrypoint.initialToken } : {}), ...(options.mcpEntrypoint.resolveBearer !== undefined ? { resolveBearer: options.mcpEntrypoint.resolveBearer } : {}), ...(options.mcpEntrypoint.onConnectionClose !== undefined ? { onConnectionClose: options.mcpEntrypoint.onConnectionClose } : {}), ...(options.mcpEntrypoint.audit !== undefined ? { audit: options.mcpEntrypoint.audit } : {}), ...(options.mcpEntrypoint.connectionLifetimeMs !== undefined ? { connectionLifetimeMs: options.mcpEntrypoint.connectionLifetimeMs } : {}) });
    assertOwner();
  } catch (error) {
    if (typeof workflow?.stop === "function") { try { await Promise.resolve(workflow.stop()); } catch { /* 启动仍失败；清理继续释放本实例资源。 */ } }
    // 一个清理步骤失败也不能阻止其余资源释放。
    try { await mcpHost?.close(); } catch { /* 继续清理 */ }
    try { await gateway?.close(); } catch { /* 继续清理 */ }
    try { releaseLock(); } finally { store.close(); }
    throw error;
  }
  heartbeatTimer = setInterval(() => {
    if (ownershipLost) return;
    try {
      const time = now();
      if (!Number.isSafeInteger(time) || time < 0) throw new Error("INVALID_KERNEL_TIME");
      const updated = store.db.prepare("UPDATE kernel_lock SET heartbeat=? WHERE id=1 AND holder=? AND heartbeat>? AND heartbeat<=?").run(time, holder, time - lockLeaseMs, time);
      if (Number(updated.changes) !== 1) ownershipLost = true;
    } catch { ownershipLost = true; }
  }, Math.floor(lockLeaseMs / 3));
  heartbeatTimer.unref?.();
  if (workflow) {
    const worker = workflow;
    workflowTimer = setInterval(() => {
      if (!isOwner() || workflowError) return;
      try {
        const result: unknown = worker.pump();
        if (result && typeof (result as { then?: unknown }).then === "function") { void Promise.resolve(result).catch(() => undefined); throw new Error("ASYNC_WORKFLOW_PUMP_FORBIDDEN"); }
      } catch { workflowError = "WORKFLOW_PUMP_FAILED"; }
    }, workflowPollMs);
    workflowTimer.unref?.();
  }
  const outbox = options.outbox;
  const workerOptions: OutboxWorkerOptions = { now, ...(outbox !== undefined ? { leaseMs: outbox.leaseMs, backoffMs: outbox.backoffMs, maxAttempts: outbox.maxAttempts, maxPerPump: outbox.maxPerPump } : {}) };
  if (outbox?.deliver) {
    const deliver = outbox.deliver;
    outboxTimer = setInterval(() => {
      if (!isOwner()) return;
      try { pumpOutbox(store, { deliver: lease => { assertOwner(); return deliver(lease); } }, workerOptions); } catch { /* 未知投递保留占位；旧owner由guard拒绝业务结算。 */ }
    }, options.outboxPollMs ?? 1000);
    outboxTimer.unref?.();
  }
  const eventWatermarks = () => (store.db.prepare("SELECT project_id AS projectId, COALESCE(MAX(sequence),0) AS lastSequence FROM events GROUP BY project_id ORDER BY project_id").all() as { projectId: string; lastSequence: number }[]).map(row => Object.freeze({ projectId: row.projectId, lastSequence: Number(row.lastSequence) }));
  const outboxTotals = () => {
    const rows = store.db.prepare("SELECT state, COUNT(*) AS n FROM outbox GROUP BY state").all() as { state: string; n: number }[];
    const totals = { pending: 0, dispatching: 0, delivered: 0, uncertain: 0, exhausted: 0 };
    for (const row of rows) if (row.state in totals) totals[row.state as keyof typeof totals] = Number(row.n);
    return Object.freeze(totals);
  };
  const quiesceWorkflow=():Promise<void>=>{
    if(workflowDrain)return workflowDrain;
    if(outboxTimer!==undefined)clearInterval(outboxTimer);
    if(workflowTimer!==undefined)clearInterval(workflowTimer);
    let observation:Promise<void>;try{observation=Promise.resolve(workflow?.stop());}catch(error){observation=Promise.reject(error);}
    let deadline:ReturnType<typeof setTimeout>;const expired=new Promise<void>(resolve=>{deadline=setTimeout(()=>{workflowError='WORKFLOW_DRAIN_DEADLINE';resolve();},stopDrainMs);});
    workflowDrain=Promise.race([observation,expired]).finally(()=>clearTimeout(deadline));
    void workflowDrain.catch(()=>undefined);return workflowDrain;
  };
  return Object.freeze({
    gateway, store, isOwner,
    ...(mcpHost ? { mcpEntrypoint: Object.freeze({ url: mcpHost.url, bearerToken: mcpHost.bearerToken }) } : {}),
    workflowStatus: () => Object.freeze({ enabled: workflow !== undefined, healthy: workflowError === null && isOwner(), lastError: workflowError, recoveredDispatches }),
    recovery: { recoveredExpiredLeases: recoveryExpired, watermarks: eventWatermarks() },
    eventWatermarks,
    outboxTotals,
    quiesceWorkflow,
    stop: () => {
      if (stopPromise) return stopPromise;
      // stop的同步部分须先保存在途未知边界，随后关闭业务入口；不等待模型完成。
      let draining: Promise<void>;
      try { draining = quiesceWorkflow(); } catch (error) { draining = Promise.reject(error); }
      void draining.catch(() => undefined);
      stopping = true;
      if (outboxTimer !== undefined) clearInterval(outboxTimer);
      if (workflowTimer !== undefined) clearInterval(workflowTimer);
      stopPromise = (async () => {
        try { const mcpClose = mcpHost?.close(); void mcpClose?.catch(() => undefined); await gateway.close(); await draining; await mcpClose; }
        finally {
          if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
          try { releaseLock(); } finally { store.close(); }
        }
      })();
      return stopPromise;
    },
  });
}

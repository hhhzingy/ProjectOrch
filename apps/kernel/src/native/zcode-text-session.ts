import { parseSessionRef, type SessionRef } from "@projectorch/adapter-contract";
import { randomUUID } from "node:crypto";
import { NativeSessionLease } from "./session-lease.js";
import { ZCodeTextProcess, type ZCodeTextProcessOptions, type ZCodeTextProcessReceipt, type ZCodeProcessSnapshot, type OwnedProcessTermination } from "./zcode-text-process.js";

export interface ZCodeSessionSnapshot {
  readonly session: SessionRef;
  readonly connectionEpoch: string;
  readonly ownerClosed: boolean;
  readonly process: ZCodeProcessSnapshot;
}
export interface ZCodeSessionObserver {
  read(): ZCodeSessionSnapshot;
  detach(): void;
}

/** 已知真实会话的纯文本受管owner；创建新原生会话后由上层登记再使用此入口。 */
export class ZCodeTextSession {
  readonly session: SessionRef;
  readonly connectionEpoch = randomUUID();
  readonly #runner: ZCodeTextProcess;
  readonly #lease: NativeSessionLease;
  #closed = false;
  constructor(directory: string, input: SessionRef, options: ZCodeTextProcessOptions) {
    this.session = parseSessionRef(input);
    if (this.session.harnessId !== "zcode") throw new Error("ZCODE_SESSION_REQUIRED");
    this.#runner = new ZCodeTextProcess(options); // 参数错误时不能遗留占位。
    this.#lease = NativeSessionLease.acquire(directory, this.session);
  }
  get phase(): "closed" | "idle" | "running" | "unknown" { return this.#closed ? "closed" : this.#runner.phase; }
  /** 观察句柄只读；断开只撤销此句柄，不拥有进程、lease或执行Promise。 */
  attachObserver(): ZCodeSessionObserver {
    if (this.#closed) throw new Error("SESSION_OWNER_CLOSED");
    let detached = false;
    return Object.freeze({
      read: (): ZCodeSessionSnapshot => {
        if (detached) throw new Error("OBSERVER_DETACHED");
        return Object.freeze({ session: this.session, connectionEpoch: this.connectionEpoch, ownerClosed: this.#closed, process: this.#runner.snapshot });
      },
      detach: () => { detached = true; },
    });
  }
  async execute(text: string, timeoutMs?: number): Promise<ZCodeTextProcessReceipt> {
    if (this.#closed) throw new Error("SESSION_OWNER_CLOSED");
    return this.#runner.execute(text, this.session.nativeConversationId, timeoutMs);
  }
  /** CLI传输没有已验证的忙时queue/guide协议；必须显式拒绝，不能改成新prompt。 */
  async deliverText(text: string, mode: "startNow" | "queue" | "guide"): Promise<ZCodeTextProcessReceipt> {
    if (mode !== "startNow") throw new Error("CLI_DELIVERY_MODE_UNSUPPORTED");
    return this.execute(text);
  }
  requestOwnedProcessTermination(expectedProcessEpoch: string): OwnedProcessTermination {
    if (this.#closed) throw new Error("SESSION_OWNER_CLOSED");
    return this.#runner.requestOwnedProcessTermination(expectedProcessEpoch);
  }
  close(): void {
    if (this.#closed || this.#runner.phase !== "idle") throw new Error("SESSION_OWNER_NOT_RELEASABLE");
    // runner在正常close事件后才回到idle；unknown包含可能残留的进程，不能释放。
    this.#lease.releaseAfterExit(true); this.#closed = true;
  }
}

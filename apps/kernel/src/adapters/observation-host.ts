import { sameSession, type SessionRef } from "@projectorch/adapter-contract";
import { beginObservation, disconnectObservation, observeFrame, type AdapterFrame, type AdapterObservation, type EventAdapter, type ObservationResult } from "@projectorch/adapter-contract/events";

/** 内核对适配器的有界观察入口。只管理观察，不启动模型或执行派发。 */
export class KernelObservationHost {
  #state: AdapterObservation;
  readonly #adapter: EventAdapter;
  readonly #epochs = new Set<string>();
  constructor(adapter: EventAdapter, session: SessionRef, connectionEpoch: string) {
    this.#state = beginObservation(session, connectionEpoch);
    this.#adapter = adapter;
    this.#adapter.connect(this.#state.session, connectionEpoch);
    this.#epochs.add(connectionEpoch);
  }
  get snapshot(): AdapterObservation { return this.#state; }
  /** 观察就绪只是派发必要条件；权限、预算、暂停等必须另由DispatchGuard检查。 */
  get observationAllowsDispatch(): boolean {
    return this.#state.connected && !this.#state.needsReconcile && this.#state.status === "idle" && this.#state.executionId === null;
  }
  disconnect(): void {
    this.#state = disconnectObservation(this.#state);
    this.#adapter.disconnect();
  }
  reconnect(session: SessionRef, connectionEpoch: string): void {
    if (this.#state.connected || this.#epochs.has(connectionEpoch) || !sameSession(this.#state.session, session)) throw new Error("INVALID_OBSERVATION_RECONNECT");
    const next = beginObservation(session, connectionEpoch);
    this.#adapter.connect(next.session, connectionEpoch);
    this.#epochs.add(connectionEpoch); this.#state = next;
  }
  poll(limit = 64): readonly ObservationResult[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024) throw new Error("INVALID_OBSERVATION_LIMIT");
    if (!this.#state.connected) return [];
    const results: ObservationResult[] = [];
    for (let count = 0; count < limit; count++) {
      let frame: AdapterFrame | null;
      try { frame = this.#adapter.next(); }
      catch {
        this.#state = disconnectObservation(this.#state);
        results.push({ disposition: "reconcile", reason: "ADAPTER_READ_FAILED", observation: this.#state });
        break;
      }
      if (frame === null) break;
      const result = observeFrame(this.#state, frame);
      this.#state = result.observation; results.push(result);
    }
    return Object.freeze(results);
  }
}

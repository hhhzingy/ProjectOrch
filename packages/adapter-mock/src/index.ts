import { parseSessionRef, sameSession, type SessionRef } from "@projectorch/adapter-contract";
import type { AdapterFrame, EventAdapter } from "@projectorch/adapter-contract/events";

export type MockStep = { readonly kind: "event"; readonly frame: AdapterFrame } | { readonly kind: "disconnect" } | { readonly kind: "error" };
/** 仅用于合成测试；无文件、网络、原生会话或兼容矩阵写入能力。 */
export class MockAdapter implements EventAdapter {
  readonly provenance = "synthetic";
  readonly capabilityState = "unverified";
  #session: SessionRef | null = null;
  #epoch: string | null = null;
  #epochs = new Set<string>();
  #steps: MockStep[] = [];
  connect(session: SessionRef, connectionEpoch: string): void {
    const parsed = parseSessionRef(session);
    if (this.#epoch !== null) throw new Error("ALREADY_CONNECTED");
    if (this.#session && !sameSession(this.#session, parsed)) throw new Error("SESSION_REPLACEMENT_FORBIDDEN");
    if (!connectionEpoch || connectionEpoch.length > 512 || this.#epochs.has(connectionEpoch)) throw new Error("INVALID_OR_REUSED_EPOCH");
    this.#session = parsed;
    this.#epoch = connectionEpoch;
    this.#epochs.add(connectionEpoch);
  }
  enqueue(...steps: MockStep[]): void {
    this.#steps.push(...structuredClone(steps));
  }
  disconnect(): void { this.#epoch = null; }
  next(): AdapterFrame | null {
    if (this.#epoch === null) throw new Error("ADAPTER_OFFLINE");
    const step = this.#steps.shift();
    if (!step) return null;
    if (step.kind === "disconnect" || step.kind === "error") {
      this.disconnect();
      throw new Error(step.kind === "error" ? "SIMULATED_TRANSPORT_ERROR" : "ADAPTER_OFFLINE");
    }
    return structuredClone(step.frame);
  }
}

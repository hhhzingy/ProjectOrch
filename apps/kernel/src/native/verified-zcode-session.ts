import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SessionRef } from "@projectorch/adapter-contract";
import type { NativeCompatibilityRegistry, NativeIdentity } from "./compatibility.js";
import { ZCodeTextSession } from "./zcode-text-session.js";
import type { ZCodeSessionObserver } from "./zcode-text-session.js";
import type { ZCodeTextProcessOptions, ZCodeTextProcessReceipt } from "./zcode-text-process.js";

export const zcodeTextAdapterProtocol = "zcode-cli-jsonl-v2";
/** 业务侧入口：启动与每次投递前复核当前字节；原始Session类留给受信兼容探针。 */
export class VerifiedZCodeTextSession {
  readonly #owner: ZCodeTextSession;
  readonly #registry: NativeCompatibilityRegistry;
  readonly #identity: NativeIdentity;
  readonly #options: ZCodeTextProcessOptions;
  constructor(directory: string, ref: SessionRef, options: ZCodeTextProcessOptions, registry: NativeCompatibilityRegistry, identity: NativeIdentity) {
    if (identity.harnessId !== "zcode" || identity.route !== "official_cli" || identity.adapterProtocol !== zcodeTextAdapterProtocol) throw new Error("UNSUPPORTED_NATIVE_ADAPTER_ROUTE");
    this.#registry = registry; this.#identity = Object.freeze({ ...identity }); this.#options = Object.freeze({ ...options, env: Object.freeze({ ...options.env }) });
    this.#assertCompatible();
    this.#owner = new ZCodeTextSession(directory, ref, this.#options);
  }
  #assertCompatible(): void {
    const hash = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
    const installed = { ...this.#identity, executableSha256: hash(this.#options.executable), bundleSha256: hash(this.#options.bundle) };
    if (installed.executableSha256 !== this.#identity.executableSha256 || installed.bundleSha256 !== this.#identity.bundleSha256) throw new Error("NATIVE_RUNTIME_CHANGED_RESTART_REQUIRED");
    for (const capability of ["textInput", "resume"] as const) {
      const decision = this.#registry.decide(installed, capability);
      if (!decision.enabled) throw new Error(decision.state === "unsupported" ? "NATIVE_CAPABILITY_UNSUPPORTED" : "NATIVE_COMPATIBILITY_PROBE_REQUIRED");
    }
  }
  async execute(text: string, timeoutMs?: number): Promise<ZCodeTextProcessReceipt> { this.#assertCompatible(); return this.#owner.execute(text, timeoutMs); }
  async deliverText(text: string, mode: "startNow" | "queue" | "guide"): Promise<ZCodeTextProcessReceipt> {
    if (mode !== "startNow") throw new Error("NATIVE_CAPABILITY_UNSUPPORTED");
    return this.execute(text);
  }
  attachObserver(): ZCodeSessionObserver { return this.#owner.attachObserver(); }
  get phase(): "closed" | "idle" | "running" | "unknown" { return this.#owner.phase; }
  close(): void { this.#owner.close(); }
}

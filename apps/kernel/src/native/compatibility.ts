/** 测试记录与运行能力分离：版本/哈希只定位历史证据，不构成运行白名单。 */
export const nativeCapabilities = Object.freeze(["textInput", "resume", "historyRead", "queue", "guide", "nativeCancel", "nativeApprovals", "roleTools"] as const);
export type NativeCapability = typeof nativeCapabilities[number];
export type NativeRoute = "official_cli" | "official_rpc" | "official_extension";
export interface NativeIdentity {
  readonly harnessId: "codex" | "zcode";
  readonly version: string;
  readonly executableSha256: string;
  readonly bundleSha256: string | null;
  readonly adapterProtocol: string;
  readonly route: NativeRoute;
}
export interface NativeCapabilityProof {
  readonly identity: NativeIdentity;
  readonly probeId: string;
  readonly evidenceSha256: string;
  readonly capabilities: Readonly<Partial<Record<NativeCapability, "verified" | "unsupported">>>;
}
export interface NativeCapabilityDecision {
  readonly state: "verified" | "unsupported" | "unverified";
  readonly enabled: boolean;
  readonly reason: "matching_probe" | "runtime_capability_available" | "adapter_capability_unavailable";
}
const shaPattern = /^[a-f0-9]{64}$/;
function identity(input: NativeIdentity): NativeIdentity {
  if (!input || Object.keys(input).some(k => !["harnessId", "version", "executableSha256", "bundleSha256", "adapterProtocol", "route"].includes(k)) || !["codex", "zcode"].includes(input.harnessId) || typeof input.version !== "string" || !input.version || input.version.length > 128 || typeof input.adapterProtocol !== "string" || !input.adapterProtocol || input.adapterProtocol.length > 128 || !shaPattern.test(input.executableSha256) || (input.bundleSha256 !== null && !shaPattern.test(input.bundleSha256)) || !["official_cli", "official_rpc", "official_extension"].includes(input.route)) throw new Error("INVALID_OFFICIAL_NATIVE_IDENTITY");
  return Object.freeze({ harnessId: input.harnessId, version: input.version, executableSha256: input.executableSha256, bundleSha256: input.bundleSha256, adapterProtocol: input.adapterProtocol, route: input.route });
}
const key = (i: NativeIdentity) => JSON.stringify([i.harnessId, i.version, i.executableSha256, i.bundleSha256, i.adapterProtocol, i.route]);
const adapterKey = (i: NativeIdentity) => JSON.stringify([i.harnessId, i.adapterProtocol, i.route]);
const basicCapabilities: readonly NativeCapability[] = Object.freeze(["textInput", "resume", "historyRead", "roleTools"]);
const codexCapabilities: readonly NativeCapability[] = Object.freeze([...basicCapabilities, "guide", "nativeCancel"]);
const implementedRoute = (i: NativeIdentity) => (i.harnessId === "codex" && i.route === "official_rpc" && i.adapterProtocol === "codex-app-server-jsonl-v2") || (i.harnessId === "zcode" && i.route === "official_cli" && i.adapterProtocol === "zcode-cli-jsonl-v2");

/** 记录入口仅供可信内核使用，不是浏览器/Agent自报能力的API。 */
export class NativeCompatibilityRegistry {
  readonly #proofs = new Map<string, NativeCapabilityProof>();
  readonly #adapterCapabilities = new Map<string, readonly NativeCapability[]>();
  /** 由实际驱动声明当前实现的能力，与 Harness 版本、程序哈希和历史测试记录无关。 */
  setAdapterCapabilities(input: NativeIdentity, capabilities: readonly NativeCapability[]): void {
    const target = identity(input);
    if (!Array.isArray(capabilities) || capabilities.some(c => !nativeCapabilities.includes(c))) throw new Error("INVALID_ADAPTER_CAPABILITIES");
    this.#adapterCapabilities.set(adapterKey(target), Object.freeze([...new Set(capabilities)]));
  }
  recordTrustedProbe(input: NativeCapabilityProof): void {
    const target = identity(input.identity);
    if (typeof input.probeId !== "string" || !input.probeId || input.probeId.length > 128 || !shaPattern.test(input.evidenceSha256) || !input.capabilities || typeof input.capabilities !== "object" || Array.isArray(input.capabilities)) throw new Error("INVALID_NATIVE_PROOF");
    const capabilities: Partial<Record<NativeCapability, "verified" | "unsupported">> = {};
    for (const [capability, state] of Object.entries(input.capabilities)) {
      if (!nativeCapabilities.includes(capability as NativeCapability) || !["verified", "unsupported"].includes(state)) throw new Error("INVALID_NATIVE_CAPABILITY_PROOF");
      capabilities[capability as NativeCapability] = state;
    }
    this.#proofs.set(key(target), Object.freeze({ identity: target, probeId: input.probeId, evidenceSha256: input.evidenceSha256, capabilities: Object.freeze(capabilities) }));
  }
  decide(input: NativeIdentity, capability: NativeCapability): NativeCapabilityDecision {
    const current = identity(input);
    if (!nativeCapabilities.includes(capability)) throw new Error("UNKNOWN_NATIVE_CAPABILITY");
    const available = this.#adapterCapabilities.get(adapterKey(current)) ?? (implementedRoute(current) ? current.harnessId === "codex" ? codexCapabilities : basicCapabilities : []);
    if (!available.includes(capability)) return Object.freeze({ state: "unsupported", enabled: false, reason: "adapter_capability_unavailable" });
    const tested = this.#proofs.get(key(current))?.capabilities[capability] === "verified";
    return Object.freeze({ state: tested ? "verified" : "unverified", enabled: true, reason: tested ? "matching_probe" : "runtime_capability_available" });
  }
}
